/**
 * Cheap Git identity from the filesystem. Exact-head and repository identity
 * proofs that must stay inside a transaction or a send guard read these files
 * instead of spawning git on the executor thread.
 *
 * Working-tree cleanliness (status, diff, untracked) still runs git, asynchronously,
 * before the transaction or as the last await before send.
 *
 * Origin is `remote.origin.url` from config, not `git remote get-url` (no insteadOf).
 * A reftable-format repository fails closed: missing loose and packed refs throw
 * rather than spawn git on the executor.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SHA = /^[a-f0-9]{40,64}$/;

export class GitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIdentityError";
  }
}

export interface GitCheckoutIdentity {
  /** Real path of the worktree root that holds `.git`. */
  toplevel: string;
  /** Real path of this checkout's git dir (the worktree git dir when linked). */
  gitDir: string;
  /** Real path of the shared git dir (`commondir`, or `gitDir` itself). */
  commonDir: string;
  /** Resolved HEAD commit. */
  head: string;
  /** Current branch name, or `""` when detached. */
  branch: string;
  /** `remote.origin.url` from config, or `""` when unset. */
  origin: string;
}

/** Read toplevel, git dir, common dir, HEAD, branch and origin without spawning git. */
export function readGitCheckout(directory: string): GitCheckoutIdentity {
  const toplevel = realpathSync(directory);
  const gitDir = resolveGitDir(toplevel);
  const commonDir = resolveCommonDir(gitDir);
  assertFilesBackend(gitDir, commonDir);
  const headText = readTrimmed(join(gitDir, "HEAD"));
  const { head, branch } = resolveHead(gitDir, commonDir, headText);
  return { toplevel, gitDir, commonDir, head, branch, origin: originUrl(gitDir, commonDir) };
}

/** Resolve a ref (`refs/heads/…`) from loose files then packed-refs. */
export function readGitRef(identity: Pick<GitCheckoutIdentity, "gitDir" | "commonDir">, ref: string): string {
  if (!ref.startsWith("refs/") || ref.includes("..") || ref.includes("\\"))
    throw new GitIdentityError(`Refused ref ${ref}`);
  return resolveRef(identity.gitDir, identity.commonDir, ref, 0);
}

function resolveGitDir(toplevel: string): string {
  const gitPath = join(toplevel, ".git");
  let stat;
  try { stat = lstatSync(gitPath); }
  catch { throw new GitIdentityError(`No .git at ${toplevel}`); }
  if (stat.isDirectory()) return realpathSync(gitPath);
  if (!stat.isFile()) throw new GitIdentityError(`Unreadable .git at ${toplevel}`);
  const text = readFileSync(gitPath, "utf8");
  const match = text.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) throw new GitIdentityError(`Malformed .git file at ${toplevel}`);
  const target = isAbsolute(match[1]) ? match[1] : resolve(toplevel, match[1]);
  return realpathSync(target);
}

function resolveCommonDir(gitDir: string): string {
  const commondir = join(gitDir, "commondir");
  if (!existsSync(commondir)) return gitDir;
  const text = readTrimmed(commondir);
  const target = isAbsolute(text) ? text : resolve(gitDir, text);
  return realpathSync(target);
}

function assertFilesBackend(gitDir: string, commonDir: string) {
  for (const root of unique([gitDir, commonDir])) {
    if (existsSync(join(root, "reftable")))
      throw new GitIdentityError(`Reftable backend at ${root}`);
  }
}

function resolveHead(gitDir: string, commonDir: string, headText: string): { head: string; branch: string } {
  if (SHA.test(headText)) return { head: headText, branch: "" };
  const match = headText.match(/^ref:\s+(refs\/heads\/.+)$/);
  if (!match) throw new GitIdentityError("HEAD is neither a commit nor a branch ref");
  const ref = match[1];
  return { head: resolveRef(gitDir, commonDir, ref, 0), branch: ref.slice("refs/heads/".length) };
}

function resolveRef(gitDir: string, commonDir: string, ref: string, depth: number): string {
  if (depth > 5) throw new GitIdentityError(`Symbolic ref loop at ${ref}`);
  for (const root of unique([gitDir, commonDir])) {
    const loose = join(root, ref);
    if (!existsSync(loose)) continue;
    const text = readTrimmed(loose);
    if (text.startsWith("ref: ")) return resolveRef(gitDir, commonDir, text.slice(4).trim(), depth + 1);
    if (SHA.test(text)) return text;
    throw new GitIdentityError(`Malformed loose ref ${ref}`);
  }
  const packed = packedRef(commonDir, ref) ?? (commonDir !== gitDir ? packedRef(gitDir, ref) : null);
  if (packed) return packed;
  throw new GitIdentityError(`Missing ref ${ref}`);
}

function packedRef(root: string, ref: string): string | null {
  const path = join(root, "packed-refs");
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const sha = line.slice(0, space), name = line.slice(space + 1).trim();
    if (name === ref && SHA.test(sha)) return sha;
  }
  return null;
}

function originUrl(gitDir: string, commonDir: string): string {
  for (const root of unique([gitDir, commonDir])) {
    const url = configRemoteUrl(join(root, "config"));
    if (url) return url;
  }
  return "";
}

function configRemoteUrl(path: string): string | null {
  if (!existsSync(path)) return null;
  let inOrigin = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]) || /^remote\.origin$/i.test(section[1]);
      continue;
    }
    if (!inOrigin) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/i);
    if (kv) return kv[1].trim();
  }
  return null;
}

function readTrimmed(path: string): string {
  try { return readFileSync(path, "utf8").trim(); }
  catch { throw new GitIdentityError(`Unreadable ${path}`); }
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
