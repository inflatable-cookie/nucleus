/**
 * The content digest Queue uses to recognise one unchanged Effigy runtime
 * artifact (Spec 035, "Runtime identity").
 *
 * The trusted declaration names an immutable artifact by path and SHA-256, and
 * run-control verifies it before *and* after every call. Hashing the whole file
 * twice per call is the right check and the wrong cost: the qualified candidate
 * is about 184 MB, so one admission's observation stream could ask the host for
 * hundreds of megabytes of hashing per second across retired rows (task 430,
 * reported by Queue Supervisor `b86c7623`). The identity check is the contract;
 * repeating the read is not.
 *
 * So the expensive part is remembered — narrowly, and only under evidence:
 *
 * - The key is the real path plus the metadata of the exact file descriptor
 *   that was opened: device, inode, size, `mtimeNs` and `ctimeNs`. `ctime` moves
 *   on every write and on every mode change, so a same-size rewrite with a
 *   restored mtime, a replacement and a `chmod` all read as different files.
 * - Every verification still opens the path, re-checks that it is a regular,
 *   executable file, and compares the opened descriptor's identity. Only a
 *   matching identity reuses bytes; anything else re-reads them.
 * - The read is bound to the descriptor it started from: the descriptor is
 *   re-checked after the read, and the path is re-resolved and re-checked too,
 *   so a mid-read rewrite, a swap or a re-pointed symlink refuses instead of
 *   publishing a mixed-file digest as verified.
 * - A read that lost its file that way starts again from the path a bounded
 *   number of times: Effigy rebuilt in place during a read is an ordinary event
 *   and the file there now is the answer. Only a file still moving after that
 *   refuses.
 * - Refusals are never remembered, so recovery is observed on the next call.
 *   The cache is bounded (least recently used evicted) and process-local.
 *
 * The cache stores content, never trust: each caller still compares the digest
 * it got against its own expected SHA-256, so one caller's declaration can
 * never validate another's. Concurrent checks of the same identity share one
 * read, and each of them makes that comparison itself.
 *
 * This is an optimization under the existing immutable-artifact contract, not a
 * new claim of file immutability: metadata identity is evidence that the bytes
 * did not change, and the before/after verification around every spawn stays
 * exactly where it was.
 */
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";

/** One artifact's exact bytes, or why they could not be read as one file. */
export type EffigyExecutableDigest =
  | { kind: "ok"; path: string; sha256: string }
  | { kind: "missing"; reason: string }
  | { kind: "not-executable"; reason: string }
  | { kind: "unreadable"; reason: string; moved?: true };

/** An artifact that cannot be observed: everything the digest reports except bytes. */
export type EffigyExecutableRefusal = Extract<EffigyExecutableDigest, { kind: "missing" | "not-executable" | "unreadable" }>;

/**
 * The identity of one executable observation: the resolved path a caller may
 * spawn, and the metadata of the exact descriptor the bytes were read from.
 */
export interface ExecutableFileIdentity {
  path: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** What the cache has cost this process, for tests and diagnostics. */
export interface ExecutableDigestCost {
  /** Completed content reads (a read that was discarded as unstable counts). */
  hashed: number;
  /** Checks answered from a remembered digest or a read already in flight. */
  reused: number;
  /** Bytes actually read from the filesystem for hashing. */
  bytesRead: number;
}

export interface ExecutableDigestCacheOptions {
  /** Entries kept at once. The oldest unused identity is evicted first. */
  limit?: number;
  /**
   * Test seam: runs after the descriptor identity is read and before its bytes
   * are. It lets a fixture inject the race the read must survive (a rewrite, a
   * swap or a re-pointed symlink) without standing in for the reader.
   */
  beforeRead?: (identity: ExecutableFileIdentity) => void | Promise<void>;
}

const DEFAULT_DIGEST_CACHE_ENTRIES = 32;
const READ_CHUNK_BYTES = 1024 * 1024;
/** Reads of one digest call when the file keeps moving under them, and the gap between them. */
export const DIGEST_READ_ATTEMPTS = 3;
const DIGEST_READ_RETRY_MS = 50;

/**
 * One bounded, process-local digest cache. The service holds one instance; a
 * test may hold its own to prove eviction without disturbing the default route.
 */
export class ExecutableDigestCache {
  private readonly limit: number;
  private readonly beforeRead: ((identity: ExecutableFileIdentity) => void | Promise<void>) | undefined;
  /** Identity key to content digest, in least-recently-used order. */
  private readonly remembered = new Map<string, string>();
  /** Identity key to the read already running for it. */
  private readonly reading = new Map<string, Promise<EffigyExecutableDigest>>();
  private readonly counters: ExecutableDigestCost = { hashed: 0, reused: 0, bytesRead: 0 };

  constructor(options: ExecutableDigestCacheOptions = {}) {
    const limit = options.limit ?? DEFAULT_DIGEST_CACHE_ENTRIES;
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_DIGEST_CACHE_ENTRIES;
    this.beforeRead = options.beforeRead;
  }

  /** What this cache has cost so far. Read-only snapshot. */
  costs(): ExecutableDigestCost {
    return { ...this.counters };
  }

  /** Test seam: start counting from now. Nothing remembered is dropped. */
  resetCosts(): void {
    this.counters.hashed = 0;
    this.counters.reused = 0;
    this.counters.bytesRead = 0;
  }

  /** How many identities are remembered right now. */
  size(): number {
    return this.remembered.size;
  }

  /**
   * The exact bytes of the executable file `pathname` names right now, as one
   * consistent read, or the reason they cannot be read that way.
   */
  async digest(pathname: string): Promise<EffigyExecutableDigest> {
    for (let attempt = 1; ; attempt += 1) {
      const read = await this.readOnce(pathname);
      if (read.kind !== "unreadable" || !read.moved || attempt === DIGEST_READ_ATTEMPTS) return read;
      await new Promise(resolve => setTimeout(resolve, DIGEST_READ_RETRY_MS));
    }
  }

  /** One read of the file `pathname` names; `moved` marks a read that lost its file. */
  private async readOnce(pathname: string): Promise<EffigyExecutableDigest> {
    let resolved: string;
    try {
      resolved = await realpath(pathname);
    } catch (error) {
      return { kind: "missing", reason: `${pathname} does not resolve: ${messageOf(error)}` };
    }
    let handle: FileHandle;
    try {
      handle = await open(resolved, "r");
    } catch (error) {
      return { kind: "unreadable", reason: `${resolved} cannot be read: ${messageOf(error)}` };
    }
    try {
      const opened = await handle.stat({ bigint: true });
      const refusal = fileRefusal(resolved, opened);
      if (refusal) return refusal;
      const identity = identityOf(resolved, opened);
      const content = await this.content(identity, handle);
      if (content.kind !== "ok") return content;
      // The bytes came from this descriptor and this path; a swap, retarget or
      // rewrite while they were read refuses here rather than publishing them.
      const moved = await pathMoved(pathname, resolved, identity);
      if (moved) return { kind: "unreadable", reason: moved, moved: true };
      return content;
    } catch (error) {
      return { kind: "unreadable", reason: `${resolved} cannot be read: ${messageOf(error)}` };
    } finally {
      await handle.close().catch(() => { /* the descriptor is already gone */ });
    }
  }

  /**
   * One identity's digest: remembered, already being read, or read now. Only an
   * identity whose bytes were read consistently is remembered.
   */
  private content(identity: ExecutableFileIdentity, handle: FileHandle): Promise<EffigyExecutableDigest> {
    const key = identityKey(identity);
    const known = this.take(key);
    if (known !== undefined) {
      this.counters.reused += 1;
      return Promise.resolve({ kind: "ok", path: identity.path, sha256: known });
    }
    const pending = this.reading.get(key);
    if (pending) {
      this.counters.reused += 1;
      return pending;
    }
    const work = this.readContent(identity, key, handle);
    this.reading.set(key, work);
    void work.then(
      () => { this.reading.delete(key); },
      () => { this.reading.delete(key); },
    );
    return work;
  }

  private async readContent(identity: ExecutableFileIdentity, key: string, handle: FileHandle): Promise<EffigyExecutableDigest> {
    try {
      await this.beforeRead?.(identity);
      const sha256 = await hashDescriptor(handle, bytes => { this.counters.bytesRead += bytes; });
      this.counters.hashed += 1;
      const after = await handle.stat({ bigint: true });
      if (identityKey(identityOf(identity.path, after)) !== key)
        return { kind: "unreadable", reason: `${identity.path} changed while its bytes were read; the digest is not published`, moved: true };
      this.remember(key, sha256);
      return { kind: "ok", path: identity.path, sha256 };
    } catch (error) {
      return { kind: "unreadable", reason: `${identity.path} cannot be read: ${messageOf(error)}` };
    }
  }

  /** A remembered digest, moved to the newest position when it is used. */
  private take(key: string): string | undefined {
    const found = this.remembered.get(key);
    if (found === undefined) return undefined;
    this.remembered.delete(key);
    this.remembered.set(key, found);
    return found;
  }

  private remember(key: string, sha256: string): void {
    this.remembered.set(key, sha256);
    while (this.remembered.size > this.limit) {
      const oldest = this.remembered.keys().next();
      if (oldest.done) break;
      this.remembered.delete(oldest.value);
    }
  }
}

/**
 * The service's one digest cache. Process-local by design: a restarted service
 * hashes once per artifact and then reuses it, and no digest ever outlives the
 * process that computed it.
 */
export const effigyArtifactDigests = new ExecutableDigestCache();

/**
 * Resolve one path to the exact bytes a process would execute: a real path (so a
 * replaced symlink is drift, not a substitute) pointing at a regular executable
 * file, digested by content. Remembered only while the opened file's identity
 * still matches (see the module comment).
 */
export function digestEffigyExecutable(pathname: string): Promise<EffigyExecutableDigest> {
  return effigyArtifactDigests.digest(pathname);
}

function identityOf(path: string, info: BigIntStats): ExecutableFileIdentity {
  return { path, device: info.dev, inode: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

/**
 * The whole identity in one string. `ctime` is part of it on purpose: it is the
 * field a same-size rewrite with a restored mtime cannot put back, and a mode
 * change moves it too.
 */
function identityKey(identity: ExecutableFileIdentity): string {
  return `${identity.path}\u0000${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}`;
}

function fileRefusal(path: string, info: BigIntStats): EffigyExecutableRefusal | null {
  if (!info.isFile()) return { kind: "not-executable", reason: `${path} is not a regular file` };
  if ((info.mode & 0o111n) === 0n) return { kind: "not-executable", reason: `${path} has no execute bit` };
  return null;
}

/**
 * Why the bytes just read no longer belong to the path that named them, or null.
 * A re-pointed symlink, a replacement and any rewrite of the same path all read
 * as movement here, so the digest is never published as the current file's.
 */
async function pathMoved(pathname: string, resolved: string, identity: ExecutableFileIdentity): Promise<string | null> {
  let current: string;
  try {
    current = await realpath(pathname);
  } catch (error) {
    return `${pathname} no longer resolves: ${messageOf(error)}`;
  }
  if (current !== resolved)
    return `${pathname} now resolves to ${current}, not ${resolved}; the bytes were read from the earlier file`;
  let info: BigIntStats;
  try {
    info = await stat(resolved, { bigint: true });
  } catch (error) {
    return `${resolved} cannot be re-read: ${messageOf(error)}`;
  }
  const refusal = fileRefusal(resolved, info);
  if (refusal) return refusal.reason;
  if (identityKey(identityOf(resolved, info)) !== identityKey(identity))
    return `${resolved} changed while its bytes were read; the digest is not published`;
  return null;
}

/** SHA-256 of one open descriptor, read at explicit positions in bounded chunks. */
async function hashDescriptor(handle: FileHandle, onBytes: (bytes: number) => void): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    onBytes(bytesRead);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
