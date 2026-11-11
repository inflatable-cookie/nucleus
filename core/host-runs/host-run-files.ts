/** Verified host-run paths, discovery files and socket handoff. */
import { writeAtomicOwnedFile as publishOwnedFile } from "../machine/owned-file.mjs";
import { CURRENT_DATA_HOME_LEAF } from "../../shared/data-home.mjs";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { HOST_RUN_SOCKET_LEAF, HOST_RUN_STAGED_SOCKET_LEAF, hostRunSocketPath, hostRunStagedSocketPath, isHostRunInnerSocketLeaf } from "./host-run-paths";
export const HOST_RUN_AUTHORITY_FORMAT = "host.run.authority";

function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.trim() ? env.HOME.trim() : homedir();
}

function homeHostRunStateDir(env: NodeJS.ProcessEnv): string {
  return join(homeDirectory(env), ".local", "state", "host-run");
}

/**
 * The account's own data directory, deliberately ignoring NUCLEUS_DATA_HOME: a
 * private instance with the real HOME must never count as live, or its service
 * binds the live host-run socket (2026-11-05, test services took it over from the
 * real one). This is a path comparison, not an adopt check: the live folder is
 * always `~/.nucleus`, even when that path is still empty or another product's.
 */
function liveQueueDataDir(env: NodeJS.ProcessEnv): string {
  return join(homeDirectory(env), CURRENT_DATA_HOME_LEAF);
}

/** Resolve existing symlinks too, including dangling links and missing leaf directories. */
function canonicalStatePath(path: string, visited = new Set<string>()): string {
  const absolute = resolve(path);
  if (visited.has(absolute)) throw new Error(`Host-run state path contains a symlink loop (${absolute})`);
  const nextVisited = new Set(visited).add(absolute);
  try { return realpathSync(absolute); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        const target = readlinkSync(absolute, "utf8");
        return canonicalStatePath(resolve(dirname(absolute), target), nextVisited);
      }
    } catch (linkError) {
      const linkCode = (linkError as NodeJS.ErrnoException).code;
      if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") throw linkError;
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalStatePath(parent, nextVisited), basename(absolute));
  }
}

function sameRealPath(left: string, right: string): boolean {
  return canonicalStatePath(left) === canonicalStatePath(right);
}

/** The contract's state directory, shared with `nucleusd` for the epoch handover. */
export function defaultHostRunStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return homeHostRunStateDir(env);
}

/**
 * Live Queue keeps Contract 010's shared host state. Other Queue stores keep
 * their scheduler files inside the matching data directory by default.
 */
export function hostRunStateDirForDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return sameRealPath(dataDir, liveQueueDataDir(env)) ? defaultHostRunStateDir(env) : join(dataDir, "host-run");
}

/** Refuse to let an isolated Queue store bind or publish under the live state root. */
export function assertHostRunStateDirSafe(
  dataDir: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  testOnlyAllowedLiveStateDir?: string,
): void {
  if (sameRealPath(dataDir, liveQueueDataDir(env))) return;
  const liveStateDir = defaultHostRunStateDir(env);
  if (!sameRealPath(stateDir, liveStateDir)) return;
  if (testOnlyAllowedLiveStateDir && sameRealPath(stateDir, testOnlyAllowedLiveStateDir)) return;
  throw new Error(`A non-live Nucleus data directory cannot use the live host-run state directory (${liveStateDir}); use <dataDir>/host-run instead`);
}
export const hostRunAuthorityPath = (stateDir: string) => join(stateDir, "authority.json");
export const hostRunTokenKeyPath = (stateDir: string) => join(stateDir, "token.key");
export {
  HOST_RUN_SOCKET_LEAF,
  HOST_RUN_STAGED_SOCKET_LEAF,
  hostRunInnerSocketPath,
  hostRunSocketPath,
  hostRunStagedSocketPath,
} from "./host-run-paths";
/** Client-visible gap bound for a make-before-break roll handoff (Spec 035). */
export const HOST_RUN_HANDOFF_GAP_MS = 500;
/** True when something accepts connections on the socket path. */
export function hostRunSocketAnswers(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolvePromise => {
    if (!existsSync(socketPath)) { resolvePromise(false); return; }
    const probe = connect(socketPath);
    const done = (live: boolean) => { clearTimeout(timer); probe.destroy(); resolvePromise(live); };
    const timer = setTimeout(() => done(false), timeoutMs);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/**
 * Incoming roll process: bind `run/scheduler.sock.staged`, prove it answers, then
 * `rename` over the live contract path so clients never see ENOENT/ECONNREFUSED.
 * Existing connections stay on the outgoing inode until that process stops. The
 * accepting owner (the front worker) receives every paused client and decides
 * when its bytes move.
 */
export interface HostRunSocketHandoff {
  server: Server;
  livePath: string;
  stagedPath: string;
  boundIno: number;
  boundAt: string;
  answeredAt: string;
  swappedAt: string | null;
  swap(): void;
  /**
   * A pre-change outgoing process bound the live path directly, so its
   * `server.close()` makes libuv unlink the name that now points at this inode
   * (nodejs/node#19729). Bind a replacement staged socket and rename it onto
   * the live path. No-op while this inode still owns the name.
   */
  reassert(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Create or adopt the owned state root and its `run` directory, verifying every
 * component (owner, mode, no symlink) before anything binds, chmods or unlinks
 * inside it.
 */
export function ensureHostRunRunDirectory(stateDir: string): void {
  let rootInfo: Stats | null = null;
  try { rootInfo = lstatSync(stateDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!rootInfo) { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); rootInfo = lstatSync(stateDir); }
  if (rootInfo.isSymbolicLink()) throw new Error(`Host-run state root is a symlink: ${stateDir}`);
  if (!rootInfo.isDirectory()) throw new Error(`Host-run state root is not a directory: ${stateDir}`);
  ensureVerifiedDirectoryChain(realpathSync(stateDir), ["run"]);
}

export async function bindStagedHostRunSocket(
  stateDir: string,
  options: { onConnection: (socket: Socket) => void },
): Promise<HostRunSocketHandoff> {
  ensureHostRunRunDirectory(stateDir);
  const livePath = hostRunSocketPath(stateDir);
  const stagedPath = hostRunStagedSocketPath(stateDir);
  assertOwnedRunDirectory(stateDir);
  removeOwnedSocketAt(stagedPath);
  const held: Socket[] = [];
  const server = createServer({ allowHalfOpen: false });
  // Every accepted client is paused. The bind's own answer probe is only held:
  // it is a liveness check, not a client, and handing it to the accepting owner
  // would make every bind look like an abandoned client when the runtime is not
  // up yet. Real clients accepted during the bind are handed over after it.
  let accept: (socket: Socket) => void = socket => { socket.pause(); held.push(socket); };
  server.on("connection", socket => { socket.pause(); accept(socket); });
  const boundAt = await new Promise<string>((resolvePromise, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
    server.once("error", fail);
    server.listen(stagedPath, () => {
      server.removeListener("error", fail);
      try {
        chmodSync(stagedPath, 0o600);
        if (!hostRunSocketIsOwnerOnly(stateDir, HOST_RUN_STAGED_SOCKET_LEAF)) {
          throw new Error("Staged host-run socket failed the verified chain check after bind");
        }
        resolvePromise(new Date().toISOString());
      } catch (error) {
        try { server.close(); } catch { /* not listening */ }
        try { unlinkSync(stagedPath); } catch { /* best effort */ }
        fail(error);
      }
    });
  });
  const boundIno = lstatSync(stagedPath).ino;
  if (!await hostRunSocketAnswers(stagedPath)) {
    for (const socket of held.splice(0)) { try { socket.destroy(); } catch { /* already gone */ } }
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    try { unlinkSync(stagedPath); } catch { /* best effort */ }
    throw new Error("Staged host-run socket did not answer");
  }
  const answeredAt = new Date().toISOString();
  accept = options.onConnection;
  for (const socket of held.splice(0)) { if (!socket.destroyed) accept(socket); }
  const handoff: HostRunSocketHandoff = {
    server, livePath, stagedPath, boundIno, boundAt, answeredAt, swappedAt: null,
    swap() {
      if (handoff.swappedAt) return;
      assertOwnedRunDirectory(stateDir);
      // Renaming over the live path replaces whatever name is there, so the entry
      // must be absent or a socket this run directory owns: never a symlink, a
      // regular file or a foreign socket.
      let existing: Stats | null = null;
      try { existing = lstatSync(livePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing && (existing.isSymbolicLink() || !existing.isSocket())) {
        throw new Error(`Host-run socket path is not an owned socket: ${livePath}`);
      }
      if (existing && uidOf() >= 0 && existing.uid !== uidOf()) throw new Error(`Host-run socket has a foreign owner: ${livePath}`);
      renameSync(stagedPath, livePath);
      handoff.swappedAt = new Date().toISOString();
      if (lstatSync(livePath).ino !== handoff.boundIno) throw new Error("Staged host-run socket inode changed during swap");
      if (!hostRunSocketIsOwnerOnly(stateDir)) throw new Error("Host-run socket failed the verified chain check after swap");
    },
    async reassert() {
      try {
        if (lstatSync(livePath).ino === handoff.boundIno) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (await hostRunSocketAnswers(livePath)) return false;
      const previous = handoff.server;
      const next = await bindStagedHostRunSocket(stateDir, options);
      next.swap();
      handoff.server = next.server;
      handoff.boundIno = next.boundIno;
      await new Promise<void>(resolvePromise => previous.close(() => resolvePromise()));
      if (lstatSync(livePath).ino !== handoff.boundIno) throw new Error("Host-run live path inode changed during reassert");
      if (!hostRunSocketIsOwnerOnly(stateDir)) throw new Error("Host-run socket failed the verified chain check after reassert");
      return true;
    },
    async close() {
      for (const socket of held.splice(0)) { try { socket.destroy(); } catch { /* already gone */ } }
      const current = handoff.server;
      await new Promise<void>(resolvePromise => current.close(() => resolvePromise()));
      const path = handoff.swappedAt ? livePath : stagedPath;
      try {
        const info = lstatSync(path);
        if (info.ino === handoff.boundIno && info.isSocket() && !info.isSymbolicLink()) unlinkSync(path);
      } catch { /* already gone or replaced */ }
    },
  };
  return handoff;
}
export const hostRunRunDir = (stateDir: string, runId: string) => join(stateDir, "runs", runId);
/** One run's supervisor plan, live state, cancel request, output and result. */
export function hostRunSupervisorPaths(stateDir: string, runId: string) {
  const root = hostRunRunDir(stateDir, runId);
  return {
    root,
    planPath: join(root, "supervisor.plan.json"),
    statePath: join(root, "supervisor.state.json"),
    cancelPath: join(root, "cancel.json"),
    disconnectPath: join(root, "disconnect.json"),
    stdoutPath: join(root, "stdout"),
    stderrPath: join(root, "stderr"),
    resultPath: join(root, "result.json"),
    submissionPath: join(root, "submission.json"),
    retentionPath: join(root, "output.retention.json"),
  };
}

export const uidOf = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Contract 010's canonical start identity; see `core/machine/start-identity.ts`. */
export { hostRunProcessStartIdentity } from "../machine/start-identity";

function ensureDirectory(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

/**
 * Create or adopt one owned directory and chmod it to 0700 through an
 * `O_NOFOLLOW | O_DIRECTORY` handle. Every component is `lstat`ed first — a
 * symlink or foreign owner refuses before any chmod — and the opened handle's
 * `(dev, ino)` must match, so a swap cannot redirect the mode change. The full
 * chain is then re-`lstat`ed with contract 010's strict checks.
 */
export function ensureVerifiedDirectoryChain(root: string, parts: string[]): void {
  const nodes: string[] = [root];
  let current = root;
  for (const part of parts) { current = join(current, part); nodes.push(current); }
  for (let index = 0; index < nodes.length; index++) {
    const path = nodes[index];
    let info: Stats | null = null;
    try { info = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!info) {
      if (index === 0) mkdirSync(path, { recursive: true, mode: 0o700 });
      else mkdirSync(path, { mode: 0o700 });
      info = lstatSync(path);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Host-run path is not an owned directory: ${path}`);
    if (uidOf() >= 0 && info.uid !== uidOf()) throw new Error(`Host-run path has a foreign owner: ${path}`);
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`Host-run path changed: ${path}`);
      fchmodSync(fd, 0o700);
    } finally { if (fd !== null) closeSync(fd); }
  }
  const entries = statTraversalChain(root, parts, "directory");
  reverifyTraversalChain(root, entries, "directory", true);
}

export function assertOwnedRunDirectory(stateDir: string): void {
  const root = realpathSync(stateDir);
  const entries = statTraversalChain(root, ["run"], "directory");
  reverifyTraversalChain(root, entries, "directory", true);
}

/** Verify the owned run directory, refusing a symlinked or swapped component. */
export function assertHostRunRunDirectory(stateDir: string): void {
  assertOwnedRunDirectory(stateDir);
}

/**
 * Clear a socket a previous owner left on the live path, after the run directory
 * is verified. Only an owned socket is removed: a symlink, a regular file or a
 * foreign owner is a refusal, never a silently replaced path.
 */
export function removeStaleHostRunSocket(stateDir: string): void {
  assertOwnedRunDirectory(stateDir);
  removeOwnedSocketAt(hostRunSocketPath(stateDir));
}

export function removeOwnedSocketAt(path: string): void {
  let info: Stats | null = null;
  try { info = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isSocket()) throw new Error(`Host-run socket path is not an owned socket: ${path}`);
  if (uidOf() >= 0 && info.uid !== uidOf()) throw new Error(`Host-run socket has a foreign owner: ${path}`);
  unlinkSync(path);
}

/** Remove one regular file under the owned subtree through the verified chain. */
export function removeVerifiedOwnedFile(root: string, parts: string[]): void {
  const target = join(root, ...parts);
  const entries = statTraversalChain(root, parts, "file");
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    const recorded = entries[entries.length - 1];
    if (info.dev !== recorded.dev || info.ino !== recorded.ino) throw new Error(`Host-run target changed: ${target}`);
    strictTraversalCheck(info, "file", target);
    reverifyTraversalChain(root, entries, "file", false);
  } finally { closeSync(fd); }
  unlinkSync(target);
}

type HostRunTraversalKind = "root" | "directory" | "file" | "socket";
interface TraversalEntry { path: string; dev: number; ino: number }

/** Test seams for the verified-traversal rule; production never sets them. */
export interface HostRunTraversalHooks {
  /** Runs after the chain `lstat` and before the target open. */
  afterChainCheck?: () => void;
  /** Runs after the target open and before the post-open re-`lstat`. */
  afterOpen?: () => void;
}

/** A realpath is inside the owned subtree only when it equals the root or is below it. */
function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Contract 010 Files: owner is the uid, directories 0700, files and sockets 0600, nothing a symlink. */
export function strictTraversalCheck(info: Stats, kind: HostRunTraversalKind, path: string): void {
  if (info.isSymbolicLink()) throw new Error(`Host-run path is a symlink: ${path}`);
  if (uidOf() >= 0 && info.uid !== uidOf()) throw new Error(`Host-run path has a foreign owner: ${path}`);
  const mode = info.mode & 0o777;
  if (kind === "root" || kind === "directory") {
    if (!info.isDirectory() || mode !== 0o700) throw new Error(`Host-run directory must be 0700: ${path}`);
  } else if (kind === "file") {
    if (!info.isFile() || mode !== 0o600) throw new Error(`Host-run file must be 0600: ${path}`);
  } else if (!info.isSocket() || mode !== 0o600) {
    throw new Error(`Host-run socket must be an owner-only socket: ${path}`);
  }
}

/** Verified traversal step 2: `lstat` the full chain and record each `(dev, ino)`. */
function statTraversalChain(root: string, parts: string[], targetKind: HostRunTraversalKind): TraversalEntry[] {
  const rootInfo = lstatSync(root);
  strictTraversalCheck(rootInfo, "root", root);
  const entries: TraversalEntry[] = [{ path: root, dev: rootInfo.dev, ino: rootInfo.ino }];
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const info = lstatSync(current);
    strictTraversalCheck(info, index === parts.length - 1 ? targetKind : "directory", current);
    entries.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return entries;
}

/** Verified traversal step 4: re-`lstat` the root and every ancestor, requiring the same checks and `(dev, ino)`. */
function reverifyTraversalChain(root: string, entries: TraversalEntry[], targetKind: HostRunTraversalKind, includeTarget: boolean): void {
  if (realpathSync(root) !== root) throw new Error("Host-run state root changed");
  const limit = includeTarget ? entries.length : entries.length - 1;
  for (let index = 0; index < limit; index++) {
    const entry = entries[index];
    const info = lstatSync(entry.path);
    strictTraversalCheck(info, index === 0 ? "root" : index === entries.length - 1 ? targetKind : "directory", entry.path);
    if (info.dev !== entry.dev || info.ino !== entry.ino) throw new Error(`Host-run path changed: ${entry.path}`);
  }
}

/** Create any missing directories on the chain (mode 0700); the verified `lstat` checks them afterwards. */
function ensureTraversalParents(root: string, parts: string[]): void {
  let current = root;
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]);
    try {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Host-run parent is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") mkdirSync(current, { mode: 0o700 });
      else throw error;
    }
    chmodSync(current, 0o700);
  }
}

/**
 * Verified traversal steps 3 and 4 for an openable target: open it with
 * `O_NOFOLLOW`, require its recorded `(dev, ino)`, then re-`lstat` the root and
 * every ancestor. A create opens the verified parent chain instead, because the
 * target has no recorded identity yet.
 */
function openVerifiedTarget(root: string, parts: string[], flags: number, mode: number, hooks?: HostRunTraversalHooks): number {
  const targetPath = join(root, ...parts);
  let exists = false;
  try { lstatSync(targetPath); exists = true; } catch { exists = false; }
  if (!exists) ensureTraversalParents(root, parts);
  const entries = exists ? statTraversalChain(root, parts, "file") : statTraversalChain(root, parts.slice(0, -1), "directory");
  hooks?.afterChainCheck?.();
  const fd = openSync(targetPath, flags | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    const info = fstatSync(fd);
    if (exists) {
      const recorded = entries[entries.length - 1];
      if (info.dev !== recorded.dev || info.ino !== recorded.ino) throw new Error(`Host-run target changed: ${targetPath}`);
    }
    strictTraversalCheck(info, "file", targetPath);
    hooks?.afterOpen?.();
    reverifyTraversalChain(root, entries, exists ? "file" : "directory", !exists);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Read one file under the owned subtree with contract 010's verified traversal
 * (the rule for implementations without descriptor-relative open): realpath the
 * root, `lstat` the full chain recording each `(dev, ino)`, open only the target
 * with `O_NOFOLLOW` and require its recorded identity, then re-`lstat` the root
 * and every ancestor.
 */
export function readCheckedHostRunFile(stateDir: string, parts: string[], hooks?: HostRunTraversalHooks): Buffer | null {
  let fd: number | null = null;
  try {
    const root = realpathSync(stateDir);
    fd = openVerifiedTarget(root, parts, constants.O_RDONLY, 0o600, hooks);
    return readFileSync(fd);
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

/** Open one file under the owned subtree, creating it when absent, with the verified chain. */
export function openVerifiedOwnedFile(stateDir: string, parts: string[], flags: number, mode = 0o600, hooks?: HostRunTraversalHooks): number {
  return openVerifiedTarget(realpathSync(stateDir), parts, flags, mode, hooks);
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch { /* the rename is already durable; a directory fsync failure is not fatal */ }
  finally { if (fd !== null) closeSync(fd); }
}

/** Write a temporary file in the same directory, fsync, then rename over the target. */
export function writeAtomicOwnedFile(path: string, payload: Buffer | string, mode = 0o600): void {
  ensureDirectory(dirname(path), 0o700);
  publishOwnedFile(path, payload, mode);
}

/**
 * Atomically write one file under the owned subtree with the verified chain: the
 * parent chain is checked and opened `O_NOFOLLOW` and matched against its
 * recorded `(dev, ino)`, the temporary file is created there, and the root and
 * every ancestor are re-`lstat`ed afterwards; any difference removes the target
 * and refuses.
 */
export function writeVerifiedOwnedFile(stateDir: string, parts: string[], payload: Buffer | string, mode = 0o600, hooks?: HostRunTraversalHooks): void {
  const root = realpathSync(stateDir);
  ensureTraversalParents(root, parts);
  const entries = statTraversalChain(root, parts.slice(0, -1), "directory");
  hooks?.afterChainCheck?.();
  const parentPath = entries[entries.length - 1].path;
  const parentFd = openSync(parentPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const parentInfo = fstatSync(parentFd);
    const recorded = entries[entries.length - 1];
    if (parentInfo.dev !== recorded.dev || parentInfo.ino !== recorded.ino) throw new Error(`Host-run directory changed: ${parentPath}`);
  } finally { closeSync(parentFd); }
  const path = join(root, ...parts);
  publishOwnedFile(path, payload, mode, { syncDirectory: "none" });
  hooks?.afterOpen?.();
  try { reverifyTraversalChain(root, entries, "directory", true); }
  catch (error) { try { unlinkSync(path); } catch { /* best effort */ } throw error; }
  fsyncDirectory(parentPath);
}

/** Append to one file under the owned subtree with the verified chain. */
export function appendVerifiedOwnedFile(stateDir: string, parts: string[], payload: Buffer | string, hooks?: HostRunTraversalHooks): void {
  const root = realpathSync(stateDir);
  const fd = openVerifiedTarget(root, parts, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600, hooks);
  try {
    if (typeof payload === "string") writeSync(fd, payload);
    else writeSync(fd, payload);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Append bytes to a path and flush; used by fixtures and by the verified writer's callers. */
export function appendOwnedFile(path: string, payload: Buffer | string): void {
  ensureDirectory(dirname(path), 0o700);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    if (typeof payload === "string") writeSync(fd, payload);
    else writeSync(fd, payload);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------
// Discovery files and the run token
// ---------------------------------------------------------------------------

export const hostRunAuthorityFileSchema = z.object({
  format: z.literal(HOST_RUN_AUTHORITY_FORMAT),
  version: z.literal(1),
  holder: z.literal("queue"),
  endpoint: z.string().min(1),
  epoch: z.number().int().positive(),
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
}).strict();
export type HostRunAuthorityFile = z.infer<typeof hostRunAuthorityFileSchema>;

/** Read the authority file under contract 010's strict Files checks. */
export function readHostRunAuthority(stateDir = defaultHostRunStateDir()): HostRunAuthorityFile | null {
  const raw = readCheckedHostRunFile(stateDir, ["authority.json"]);
  if (!raw) return null;
  try { return hostRunAuthorityFileSchema.parse(JSON.parse(raw.toString("utf8"))); }
  catch { return null; }
}


/** Verify the socket with the verified chain: `lstat` the chain, then re-`lstat` root and target. */
export function hostRunSocketIsOwnerOnly(stateDir = defaultHostRunStateDir(), socketLeaf = HOST_RUN_SOCKET_LEAF): boolean {
  try {
    if (socketLeaf !== HOST_RUN_SOCKET_LEAF && socketLeaf !== HOST_RUN_STAGED_SOCKET_LEAF
      && !isHostRunInnerSocketLeaf(socketLeaf)) return false;
    const root = realpathSync(stateDir);
    const entries = statTraversalChain(root, ["run", socketLeaf], "socket");
    // A Unix socket cannot be opened; the post-open rule is a second `lstat` of
    // the target and every ancestor, so a swap between the two checks refuses.
    reverifyTraversalChain(root, entries, "socket", true);
    return true;
  } catch { return false; }
}
