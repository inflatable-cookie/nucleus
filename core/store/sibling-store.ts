import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { git as defaultGit, gitSlow } from "../git/index";

type GitFn = (cwd: string, ...args: string[]) => Promise<string>;

/**
 * Spec 028: one shared, isolated Git object store per sibling origin, kept
 * under the Queue data directory so every worktree group's copy of the same
 * sibling shares its history once instead of holding a full clone each.
 *
 * Isolation contract: the store is bare and never built in, never pruned and
 * never fetched into by a task; a sibling checkout keeps its own refs, HEAD,
 * index and working tree, so no task can see or change another task's source
 * through the store. Objects are shared only by their content address, never
 * by path. A checkout whose store is missing is repaired from its own origin
 * in the same pass, so correctness never depends on cache state.
 */

/** Host-level root for shared sibling object stores under the Queue data directory. */
export const SIBLING_STORE_DIR = "sibling-store";
export const siblingStoreRootFor = (dataDir: string) => join(dataDir, SIBLING_STORE_DIR);

/** The canonical store directory for an origin: sha256 of the normalised URL, so two spellings of one repository share. */
export function siblingStorePathFor(storeDir: string, origin: string): string {
  const normalised = origin.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  return join(storeDir, `${createHash("sha256").update(normalised).digest("hex")}.git`);
}

export interface CheckoutShare {
  path: string;
  name: string;
  store: string;
  head: string;
}

export type SiblingStoreShare =
  | { kind: "shared" | "already"; store: string; head: string }
  | { kind: "busy" }
  | { kind: "skipped"; detail: string };

const LOCK_STALE_MS = 15 * 60_000; // Above the gitSlow ceiling, so a long clone or repack never outlives its own lock.

const hasPacks = async (gitDir: string) =>
  (await readdir(join(gitDir, "objects", "pack")).catch(() => [] as string[])).some(name => name.endsWith(".pack"));

interface SiblingAlternates {
  gitDir: string;
  /** Every non-comment entry, resolved the way Git resolves them: relative entries against the checkout's objects directory. */
  entries: string[];
}

async function readSiblingAlternates(path: string, git: GitFn): Promise<SiblingAlternates> {
  const gitDir = await git(path, "rev-parse", "--path-format=absolute", "--git-dir");
  const file = join(gitDir, "objects", "info", "alternates");
  let entries: string[] = [];
  try {
    entries = (await readFile(file, "utf8"))
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => isAbsolute(line) ? line : resolve(gitDir, "objects", line));
  } catch { /* No alternates: the checkout holds its own objects. */ }
  return { gitDir, entries };
}

/** Queue's own alternates file is exactly one line naming the canonical store. Anything else is foreign. */
const linkedToUs = (entries: string[], storeObjects: string) => entries.length === 1 && entries[0] === storeObjects;

/**
 * Create the bare object store for an origin when it is missing. The first
 * mirror clone copies from the checkout itself (local hardlinks, no network);
 * when the checkout cannot serve its objects (a store lost under a linked
 * checkout) the store is rebuilt from the checkout's origin instead. Creation
 * lands through an atomic rename so a concurrent pass either uses the winner
 * or discards its own copy.
 */
async function ensureStore(store: string, storeDir: string, origin: string, checkout: string, slow: GitFn): Promise<void> {
  if (existsSync(join(store, "objects"))) return;
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const tmp = `${store}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    try {
      await slow(checkout, "clone", "--mirror", "--quiet", checkout, tmp);
    } catch {
      await rm(tmp, { recursive: true, force: true });
      await slow(checkout, "init", "--bare", "--quiet", tmp);
      await slow(tmp, "fetch", "--quiet", "--no-tags", origin, "+refs/heads/*:refs/heads/*");
    }
    // The store is append-only infrastructure: nothing in Queue ever prunes it,
    // so objects a linked checkout pins cannot be collected underneath it.
    await slow(tmp, "config", "gc.auto", "0");
    try {
      await rename(tmp, store);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // A concurrent creator won the store; either copy serves every borrower.
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  if (!existsSync(join(store, "objects"))) throw new Error("store creation produced no object store");
}

/** Give the store every object the checkout can drop, before the checkout drops them. */
async function updateStoreFromCheckout(store: string, checkout: string, slow: GitFn): Promise<void> {
  await slow(store, "fetch", "--quiet", checkout, "+refs/*:refs/*");
}

async function linkAlternates(gitDir: string, storeObjects: string): Promise<void> {
  const info = join(gitDir, "objects", "info");
  await mkdir(info, { recursive: true });
  const file = join(info, "alternates");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${storeObjects}\n`, { mode: 0o644 });
  await rename(tmp, file);
}

/** One writer per checkout: concurrent passes never repack the same objects concurrently. */
async function withSiblingLock<T>(storeDir: string, path: string, body: () => Promise<T>): Promise<T | { busy: true }> {
  const dir = join(storeDir, "locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, createHash("sha256").update(path).digest("hex"));
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(file).catch(() => null);
    if (info && Date.now() - info.mtimeMs <= LOCK_STALE_MS) return { busy: true };
    await rm(file, { force: true });
    try {
      handle = await open(file, "wx");
    } catch {
      return { busy: true };
    }
  }
  try {
    await handle.writeFile(String(process.pid));
    return await body();
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}

/**
 * Share a clean, detached sibling checkout into its origin's object store:
 * borrow the store's objects, then repack so the checkout holds only objects
 * the store lacks. The recorded head, refs, index and working tree are never
 * moved, and the result is re-proved before returning.
 */
export async function shareSiblingInStore(path: string, storeDir: string, git: GitFn = defaultGit): Promise<SiblingStoreShare> {
  const slow = git === defaultGit ? gitSlow : git;
  const outcome = await withSiblingLock(storeDir, path, async (): Promise<SiblingStoreShare> => {
    const head = await git(path, "rev-parse", "HEAD");
    if (await git(path, "branch", "--show-current")) return { kind: "skipped", detail: "attached to a branch" };
    if (await git(path, "status", "--porcelain")) return { kind: "skipped", detail: "no longer clean" };
    const origin = await git(path, "remote", "get-url", "origin");
    const store = siblingStorePathFor(storeDir, origin);
    const storeObjects = join(store, "objects");
    const { gitDir, entries } = await readSiblingAlternates(path, git);
    if (entries.length && !linkedToUs(entries, storeObjects)) {
      // A foreign object store — any file whose entries are not exactly Queue's
      // canonical store, absolute or relative, existing or vanished — is never
      // rewritten and never dropped: a vanished foreign target surfaces through
      // the refresh pass's own finding instead.
      return { kind: "skipped", detail: "foreign object store" };
    }
    if (!entries.length) {
      await ensureStore(store, storeDir, origin, path, slow);
      await updateStoreFromCheckout(store, path, slow);
      await linkAlternates(gitDir, storeObjects);
      await slow(path, "repack", "-a", "-d", "-l", "--quiet");
    } else if (await hasPacks(gitDir)) {
      // Already linked. A vanished store is rebuilt from this healthy checkout
      // here; locally packed increments (an interrupted link or a packed fetch)
      // are absorbed by the store and then dropped from the checkout. A failed
      // store update only leaves the pack in place.
      await ensureStore(store, storeDir, origin, path, slow);
      try {
        await updateStoreFromCheckout(store, path, slow);
      } catch { /* The store keeps what it has; the pack is dropped another pass. */ }
      await slow(path, "repack", "-a", "-d", "-l", "--quiet");
    }
    if (await git(path, "rev-parse", "HEAD") !== head) throw new Error("head changed while sharing");
    if (await git(path, "status", "--porcelain")) throw new Error("checkout became dirty while sharing");
    await git(path, "cat-file", "-e", `${head}^{commit}`);
    return { kind: entries.length ? "already" : "shared", store, head };
  });
  return "busy" in outcome ? { kind: "busy" } : outcome;
}

/**
 * The checkout's Queue-owned object-store path when the checkout is linked to
 * it and it is missing on disk, else null. A foreign alternates file — any
 * other entries, however spelled — is never named here: it is never rewritten
 * by a repair.
 */
export async function missingAlternatesTarget(path: string, storeDir: string, git: GitFn = defaultGit): Promise<string | null> {
  const { entries } = await readSiblingAlternates(path, git);
  if (!linkedToUs(entries, join(siblingStorePathFor(storeDir, await git(path, "remote", "get-url", "origin")), "objects"))) return null;
  return !existsSync(entries[0]) ? entries[0] : null;
}

/**
 * Rebuild the canonical object store for a checkout whose recorded store is
 * missing, and repoint the checkout at it. No repack and no proof here: the
 * caller retries the normal refresh pass, which fails loudly if the store is
 * still not usable.
 */
export async function repairSiblingStore(path: string, storeDir: string, git: GitFn = defaultGit): Promise<void> {
  const slow = git === defaultGit ? gitSlow : git;
  const origin = await git(path, "remote", "get-url", "origin");
  const store = siblingStorePathFor(storeDir, origin);
  await ensureStore(store, storeDir, origin, path, slow);
  const { gitDir, entries } = await readSiblingAlternates(path, git);
  if (!linkedToUs(entries, join(store, "objects"))) return;
  await linkAlternates(gitDir, join(store, "objects"));
}
