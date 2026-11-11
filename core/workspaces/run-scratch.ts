import type { RunScratchPlacement } from '../host/types';
export type { RunScratchPlacement } from '../host/types';
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { createCheckoutScratchDirectory, removeCheckoutRunScratchDirectory, type CheckoutVolumeInfo } from "./checkout-volume";
import { getWorkRoot } from "./work-root.mjs";

/**
 * Queue #535 (papercut 5ac8ffb0): every Queue-launched run gets its own TMPDIR
 * under the configured scratch root.
 *
 * A test runner that publishes its IPC endpoint under `TMPDIR` — tsx names one
 * socket per process in the temp directory — collides with another run's
 * leftover when two runs share a temp root: the second process dies with
 * `EADDRINUSE` before any assertion, and the same files pass from a separate
 * checkout. The Queue #530 reviewer hit that twice. One directory per run, named
 * by the run's own durable identity, makes two concurrent runs independent and
 * makes an abandoned socket harmless to every later run.
 *
 * The directory lives on the configured work root.
 * When the root has a volume pin, creation proves that identity first; an
 * absent mount refuses the launch without a fallback.
 */
// Recorded runs may still point at northstar-queue; only new run roots use nucleus.
export const RUN_SCRATCH_NAMESPACE = "nucleus";
const SCRATCH_NAMESPACE_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;

export function repositoryScratchNamespace(repository: string | null | undefined, override?: string | null): string {
  if (override !== undefined && override !== null) {
    if (!SCRATCH_NAMESPACE_SHAPE.test(override)) throw new Error("Repository scratch namespace is invalid");
    return override;
  }
  const identity = (repository ?? "").trim();
  const name = identity.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\\.git$/i, "")?.toLowerCase() || "repository";
  const safe = name.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/g, "");
  return SCRATCH_NAMESPACE_SHAPE.test(safe) ? safe : "repository";
}

/**
 * The scratch root Queue's own run temp directories live under. It is kept short
 * on purpose: macOS caps a Unix socket path at 104 bytes. Test fixtures use
 * short hash-named directories directly under TMPDIR so the longest repository
 * namespace still leaves room for the socket leaf.
 */
export function runScratchRoot(mount: string = getWorkRoot(), namespace = RUN_SCRATCH_NAMESPACE): string {
  if (!SCRATCH_NAMESPACE_SHAPE.test(namespace)) throw new Error("Repository scratch namespace is invalid");
  return join(mount, "scratch", namespace);
}

/** Where run temp directories lived before the short root; recorded runs keep theirs. */

/** A run identity is a durable name, never a path: reject anything else before it is joined. */
const runIdShape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

/** A run's directory is named by a short digest of its id, so the whole path stays socket-sized. */
export function runTemporaryDirectory(runId: string, root: string): string {
  if (!runIdShape.test(runId)) throw new Error(`Run id ${JSON.stringify(runId)} cannot name a run temp directory`);
  return join(root, createHash("sha256").update(runId).digest("hex").slice(0, 8));
}

/**
 * The production placement: the configured scratch root, created only after the
 * root proves its canonical path and any configured volume identity.
 */
export function checkoutRunScratchPlacement(options: {
  mount?: string;
  namespace?: string;
  uuid?: string;
  observe?: (mount: string) => CheckoutVolumeInfo;
  create?: (directory: string) => void;
} = {}): RunScratchPlacement {
  const mount = options.mount ?? getWorkRoot();
  const root = runScratchRoot(mount, options.namespace ?? RUN_SCRATCH_NAMESPACE);
  return {
    mount, root,
    create: directory => createCheckoutScratchDirectory({ mount, root, target: directory, uuid: options.uuid, observe: options.observe, create: options.create, exclusive: true }),
    createAtRoot: (recordedRoot, directory) => createCheckoutScratchDirectory({ mount, root: recordedRoot, target: directory, uuid: options.uuid, observe: options.observe, create: options.create, exclusive: true }),
    remove: directory => removeCheckoutRunScratchDirectory({ mount, root, target: directory, uuid: options.uuid, observe: options.observe }),
    withNamespace: namespace => checkoutRunScratchPlacement({ ...options, namespace }),
  };
}

/** Overlay a recorded run temp directory onto a listed launch environment. Absent directory keeps the listed values. */
export function withRunTemporaryDirectory(listed: Record<string, string>, directory: string | undefined): Record<string, string> {
  if (!directory) return listed;
  return { ...listed, TMPDIR: directory, TMP: directory, TEMP: directory };
}

/** The per-run temp environment for a turn, with its directory proved and created. */
export function runTemporaryEnvironment(runId: string, placement: RunScratchPlacement = checkoutRunScratchPlacement(), recordedDirectory?: string): Record<string, string> {
  const directory = runTemporaryDirectory(runId, placement.root);
  if (recordedDirectory && recordedDirectory !== directory) {
    // A persisted run keeps its own recorded namespace even if repository
    // settings changed after dispatch. Earlier Queue roots remain readable too.
    const hash = createHash("sha256").update(runId).digest("hex").slice(0, 8);
    const legacyHash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
    const recordedMount = recordedDirectory.startsWith(`${placement.mount}/scratch/`) ? placement.mount : undefined;
    const relativeRoot = recordedMount ? dirname(recordedDirectory).slice(`${recordedMount}/scratch/`.length) : "";
    const currentRecordedRoot = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(relativeRoot);
    const legacyRecordedRoot = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?\/(?:q|r)$/.test(relativeRoot);
    const legacyRoot = ((recordedMount && /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?\/runs$/.test(relativeRoot) && basename(recordedDirectory) === runId) || recordedDirectory === join(placement.root, "runs", runId)) && runIdShape.test(runId);
    if ((currentRecordedRoot && basename(recordedDirectory) === hash) || (legacyRecordedRoot && basename(recordedDirectory) === legacyHash) || legacyRoot) {
      const root = dirname(recordedDirectory);
      if (!placement.createAtRoot) throw new Error("Recorded run temp directory cannot be proved on its recorded storage");
      try { placement.createAtRoot(root, recordedDirectory); }
      catch (error) {
        if (!(error instanceof Error) || !/EEXIST/.test(error.message)) throw error;
        const stat = lstatSync(recordedDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(recordedDirectory) !== recordedDirectory) throw error;
      }
      return { TMPDIR: recordedDirectory, TMP: recordedDirectory, TEMP: recordedDirectory };
    }
    throw new Error("Recorded run temp directory does not match its run identity");
  }
  try {
    placement.create(directory);
  } catch (error) {
    // A persisted run may be retried after an uncertain agent creation. Reuse only
    // its exact, real leaf; a different run id always has a different directory.
    if (!(error instanceof Error) || !/EEXIST/.test(error.message)) throw error;
    try {
      const stat = lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) throw error;
    } catch { throw error; }
  }
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}

/**
 * Remove a recorded run leaf under any admitted repository namespace. A leaf off the
 * checkout volume is history from a drive Queue no longer uses: it is absent, so
 * there is nothing to clean up, and the drive is never probed.
 */
export function removeRecordedRunScratchDirectory(directory: string, fixture?: {
  mount: string; uuid: string; observe: (mount: string) => CheckoutVolumeInfo;
}): boolean {
  const mount = fixture?.mount ?? getWorkRoot();
  if (!directory.startsWith(`${mount}/scratch/`)) return true;
  const relativePath = directory.slice(`${mount}/scratch/`.length);
  const current = relativePath.match(/^([a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?)\/([a-f0-9]{8})$/);
  const earlier = relativePath.match(/^([a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?)\/(q|r)\/([a-f0-9]{12})$/);
  const old = relativePath.match(/^([a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?)\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/);
  if (!current && !earlier && !old) return false;
  return removeCheckoutRunScratchDirectory({ root: dirname(directory), target: directory, mount,
    uuid: fixture?.uuid, observe: fixture?.observe });
}
