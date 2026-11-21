import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  CONTROL_SCHEMA, CONTROL_SCHEMA_V2, CONTROL_SCHEMA_V3, CONTROL_SCHEMA_V4, CONTROL_SCHEMA_V5, CONTROL_SCHEMA_V6, CONTROL_SCHEMA_V7,
  MANIFEST_MAX_BYTES, LEGACY_HOOK_MANIFEST_PATH, NEUTRAL_HOOK_MANIFEST_PATH, HOOK_MANIFEST_PATHS, canonicalWireName,
  controlManifestSchema, hookWireFamilyOfManifestPath, hookWireFamilyOfSchema, normalizeControlManifest, normalizeRepoRelativePath,
  reservedNeutralAllowedPath,
  type HookProgram, type HookProgramPin, type ControlManifest, type NormalizedControlManifest, type HookPin, type InstructionArtifact,
  type HookWireFamily,
} from "../../shared/hooks";
import { gitRun, formatGitError } from "../git/git-command";

const CONTROL_SCHEMAS = [CONTROL_SCHEMA, CONTROL_SCHEMA_V2, CONTROL_SCHEMA_V3, CONTROL_SCHEMA_V4, CONTROL_SCHEMA_V5, CONTROL_SCHEMA_V6, CONTROL_SCHEMA_V7] as const;

export const blobDigest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function repositoryIsGitCheckout(repoPath: string): boolean {
  return existsSync(join(repoPath, ".git"));
}

interface TreeEntry { mode: string; type: string; sha: string; bytes: Buffer }
const treeEntryCache = new Map<string, { identity: string; entry: TreeEntry | null }>();

async function readTreeEntry(repoPath: string, commit: string, path: string): Promise<TreeEntry | null> {
  // Mutable refs and working files remain fresh; only immutable tree objects qualify.
  const identity = checkoutIdentity(repoPath);
  const key = `${resolve(repoPath)}\0${commit}\0${path}`;
  const cached = treeEntryCache.get(key);
  const copy = (entry: TreeEntry | null) => entry ? { ...entry, bytes: Buffer.from(entry.bytes) } : null;
  if (/^[a-f0-9]{40}$/.test(commit) && identity !== null && cached?.identity === identity) return copy(cached.entry);
  const entry = await loadTreeEntry(repoPath, commit, path);
  if (/^[a-f0-9]{40}$/.test(commit) && identity !== null && checkoutIdentity(repoPath) === identity && (!entry || entry.bytes.length <= MANIFEST_MAX_BYTES)) {
    if (treeEntryCache.size >= 256) treeEntryCache.delete(treeEntryCache.keys().next().value!);
    treeEntryCache.set(key, { identity, entry: copy(entry) });
  }
  return entry;
}

async function loadTreeEntry(repoPath: string, commit: string, path: string): Promise<TreeEntry | null> {
  const listing = await gitRun(repoPath, ["ls-tree", commit, "--", path]);
  if (listing.code !== 0) throw new Error(formatGitError(["ls-tree"], listing.code, listing.signal, listing.stderr));
  const line = listing.stdout.toString("utf8").trim();
  if (!line) return null;
  const rows = line.split("\n");
  if (rows.length !== 1) return null;
  const match = rows[0].match(/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/);
  if (!match || match[4] !== path) return null;
  const [, mode, type, sha] = match;
  const blob = type === "blob" ? await gitRun(repoPath, ["cat-file", "blob", sha]) : { code: 0, stdout: Buffer.alloc(0), stderr: "" };
  if (blob.code !== 0) throw new Error(formatGitError(["cat-file", "blob", sha], blob.code, blob.signal, blob.stderr));
  return { mode, type, sha, bytes: blob.stdout };
}

/** Validate an instruction artifact against the exact committed blob and return the pinned identity. */
export async function pinInstruction(repoPath: string, input: InstructionArtifact): Promise<InstructionArtifact> {
  const path = normalizeRepoRelativePath(input.path);
  const entry = await readTreeEntry(repoPath, input.commit, path);
  if (!entry) throw new Error(`Instruction is missing at ${input.commit}: ${path}`);
  if (entry.type !== "blob" || !/^100(644|755)$/.test(entry.mode)) throw new Error("Instruction must be one regular committed blob");
  const digestValue = blobDigest(entry.bytes);
  if (digestValue !== input.digest) throw new Error("Instruction digest does not match the committed blob");
  return { ...input, path, digest: digestValue };
}

/** Build a generic instruction artifact from any committed regular blob. No document grammar is read. */
export async function instructionForCommit(repoPath: string, commit: string, path: string, mediaType: string): Promise<InstructionArtifact> {
  const normalized = normalizeRepoRelativePath(path);
  const entry = await readTreeEntry(repoPath, commit, normalized);
  if (!entry || entry.type !== "blob" || !/^100(644|755)$/.test(entry.mode)) throw new Error("Instruction must be one regular committed blob");
  return instructionArtifactFor(entry, normalized, commit, mediaType);
}

function instructionArtifactFor(entry: TreeEntry, path: string, commit: string, mediaType: string): InstructionArtifact {
  return { path, commit, digest: blobDigest(entry.bytes), mediaType };
}

export interface ManifestDiscovery { pin: HookPin; manifest: NormalizedControlManifest; bytes: Buffer }

export function parseManifestBytes(bytes: Buffer): ControlManifest {
  return parseManifestWithFamily(bytes).manifest;
}

/** Parse a manifest and report the wire family its schema is spelled in. */
function parseManifestWithFamily(bytes: Buffer): { manifest: ControlManifest; family: HookWireFamily | null } {
  const text = bytes.toString("utf8");
  if (bytes.length > MANIFEST_MAX_BYTES) throw new Error("Control manifest exceeds 64 KiB");
  if (Buffer.from(text, "utf8").length !== bytes.length) throw new Error("Control manifest must be UTF-8");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Control manifest is not valid JSON"); }
  // JSON.parse keeps the last duplicate key; the YAML parser is used only to reject duplicate keys.
  const doc = parseDocument(text, { schema: "json", uniqueKeys: true });
  if (doc.errors.length) throw new Error("Control manifest contains duplicate keys");
  const family = manifestSchemaFamily(value);
  const manifest = controlManifestSchema.parse(value);
  // A neutral manifest is a new surface, so its own namespace is reserved for it alone.
  if (family === "neutral") {
    const hooks = (value as { hooks?: { allowedPaths?: string[] }[] }).hooks ?? [];
    for (const hook of hooks) for (const path of hook.allowedPaths ?? []) {
      if (reservedNeutralAllowedPath(path)) throw new Error(`Reserved path may not be declared: ${path}`);
    }
  }
  return { manifest, family };
}

/** The family a raw manifest's declared schema is spelled in; a non-string schema is refused by the schema parse. */
function manifestSchemaFamily(value: unknown): HookWireFamily | null {
  const schema = value && typeof value === "object" ? (value as { schema?: unknown }).schema : undefined;
  return typeof schema === "string" ? hookWireFamilyOfSchema(schema) : null;
}

/**
 * Settled manifest discoveries, by checkout and commit. A commit's tree cannot
 * change, so the answer for one (checkout, commit) pair stands until the
 * checkout itself is replaced: every hit revalidates the `.git` entry that
 * identifies this checkout, and a worktree that is removed and recreated at the
 * same path has a different one, so it reads again. Bounded, least recently used
 * evicted, and never written for a failed read - a git error is a failed read,
 * not an absent manifest.
 */
const MANIFEST_DISCOVERY_LIMIT = 256;
const manifestDiscoveryCache = new Map<string, { gitEntry: string; discovery: ManifestDiscovery | null }>();

/** The identity of the checkout at this path, or null when there is none to trust. */
function checkoutIdentity(repoPath: string): string | null {
  try {
    const stat = lstatSync(join(repoPath, ".git"));
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
  } catch { return null; }
}

/** Forget settled discoveries. With a path, only that checkout's; without, all of them. */
export function forgetManifestDiscovery(repoPath?: string) {
  if (repoPath === undefined) { manifestDiscoveryCache.clear(); return; }
  const prefix = `${resolve(repoPath)}\0`;
  for (const key of [...manifestDiscoveryCache.keys()]) if (key.startsWith(prefix)) manifestDiscoveryCache.delete(key);
}

/**
 * Read the optional closed control manifest pinned to the event base commit.
 * The neutral and legacy locations are exclusive: a commit that carries both is
 * refused rather than resolved by precedence, and a manifest's schema family
 * must match the family of the location it was read from.
 */
export async function discoverManifest(repoPath: string, baseCommit: string): Promise<ManifestDiscovery | null> {
  if (!repositoryIsGitCheckout(repoPath)) return null;
  const key = `${resolve(repoPath)}\0${baseCommit}`;
  const gitEntry = checkoutIdentity(repoPath);
  const settled = manifestDiscoveryCache.get(key);
  if (settled && gitEntry !== null && settled.gitEntry === gitEntry) {
    manifestDiscoveryCache.delete(key);
    manifestDiscoveryCache.set(key, settled);
    return settled.discovery;
  }
  const found: { path: string; entry: TreeEntry }[] = [];
  for (const path of HOOK_MANIFEST_PATHS) {
    const entry = await readTreeEntry(repoPath, baseCommit, path);
    if (entry) found.push({ path, entry });
  }
  if (found.length > 1) throw new Error(`${NEUTRAL_HOOK_MANIFEST_PATH} and ${LEGACY_HOOK_MANIFEST_PATH} are both committed at ${baseCommit.slice(0, 12)}; keep exactly one hook manifest`);
  const discovery = found.length ? manifestDiscovery(found[0].entry, baseCommit, found[0].path) : null;
  if (gitEntry !== null) {
    if (manifestDiscoveryCache.size >= MANIFEST_DISCOVERY_LIMIT && !manifestDiscoveryCache.has(key))
      manifestDiscoveryCache.delete(manifestDiscoveryCache.keys().next().value!);
    manifestDiscoveryCache.set(key, { gitEntry, discovery });
  }
  return discovery;
}

/** The one pinned identity of a committed manifest entry, or null when the commit has none. */
function manifestDiscovery(entry: TreeEntry | null, baseCommit: string, path: string): ManifestDiscovery | null {
  if (!entry) return null;
  if (entry.type !== "blob" || !/^100(644|755)$/.test(entry.mode)) throw new Error(`${path} must be a regular committed blob`);
  const { manifest, family } = parseManifestWithFamily(entry.bytes);
  if (!(CONTROL_SCHEMAS as readonly string[]).includes(canonicalWireName(manifest.schema))) throw new Error("Unsupported control manifest schema");
  const location = hookWireFamilyOfManifestPath(path);
  if (location !== family) throw new Error(`${path} is a ${location} manifest location and must declare ${location} schema names`);
  return { pin: { path, commit: baseCommit, digest: blobDigest(entry.bytes) }, manifest: normalizeControlManifest(manifest), bytes: entry.bytes };
}

/** Pin one repository-local executable to an exact regular, executable, non-symlink blob. */
export async function pinExecutable(repoPath: string, commit: string, path: string): Promise<HookPin> {
  const normalized = normalizeRepoRelativePath(path);
  if (HOOK_MANIFEST_PATHS.includes(normalized as (typeof HOOK_MANIFEST_PATHS)[number]) || normalized.startsWith(".git/") || normalized === ".git") throw new Error(`Reserved path may not be an executable: ${normalized}`);
  const entry = await readTreeEntry(repoPath, commit, normalized);
  if (!entry) throw new Error(`Hook executable is missing at ${commit}: ${normalized}`);
  if (entry.type !== "blob" || entry.mode !== "100755") throw new Error(`Hook executable must be one regular executable blob: ${normalized}`);
  return { path: normalized, commit, digest: blobDigest(entry.bytes) };
}

export async function pinProgram(repo: string, commit: string, program: HookProgram): Promise<HookProgramPin> {
  if (program.kind === "repository") return { kind: "repository", executable: await pinExecutable(repo, commit, program.executable), argv: program.argv };
  for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = resolve(directory, program.name);
    try {
      const path = await realpath(candidate);
      const info = await lstat(path);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
      return { kind: "tool", name: program.name, path, digest: blobDigest(await readFile(path)), argv: program.argv };
    } catch { /* Try the next PATH entry. */ }
  }
  return { kind: "unavailable_tool", name: program.name, argv: program.argv, error: `${program.name} not found on Nucleus's PATH` };
}
