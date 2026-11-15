/**
 * Task 104/114: where a milestone QA run's own files live. One owner of the
 * isolation data directory, the Queue-owned checkout allocation identity, the
 * run root, and the run's temporary leaf. A fixture injects its own placement;
 * production derives both from the configured work root.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertCheckoutAvailable, liveCheckoutDataDir } from "../workspaces/checkout-volume";
import { getWorkRoot } from "../workspaces/work-root.mjs";
import { isolationDataDirFor } from "../hooks/hooks";
import { digest, type Store } from "../store/store";
import {
  checkoutRunScratchPlacement, removeRecordedRunScratchDirectory, runTemporaryEnvironment,
  type RunScratchPlacement,
} from "../workspaces/run-scratch";
import type { ProjectQaRun } from "../../shared/contracts";
import { qaRunRootPath } from "./project-qa-supervision-files";
import type { ProjectQaOptions } from "./project-qa-context";

export interface QaPlacementContext {
  store: Pick<Store, "path" | "qaRun" | "putQaRun" | "scratchNamespaceFor">;
  options: Pick<ProjectQaOptions, "dataDir" | "testPlacement" | "runScratch" | "hostRunStateDir">;
}

/** The placement a run's checkout and scratch are proved against, if the process has one. */
function qaPlacement(context: QaPlacementContext) {
  if (context.options.testPlacement) return context.options.testPlacement;
  const dataDir = liveCheckoutDataDir(projectQaPlacement.isolationDataDir(context));
  return dataDir ? { dataDir, admit: (path: string) => assertCheckoutAvailable({ target: path }) } : null;
}

export const projectQaPlacement = {
  /** The store's isolation data directory, real when it exists. */
  isolationDataDir(context: QaPlacementContext): string {
    const dir = context.options.dataDir ?? isolationDataDirFor(context.store);
    try { return realpathSync(dir); } catch { return resolve(dir); }
  },
  hostRunStateDir(context: QaPlacementContext): string {
    return context.options.hostRunStateDir ?? join(projectQaPlacement.isolationDataDir(context), "host-run");
  },
  qaPlacement,
  /** The roots a Queue-owned checkout may sit under; a checkout outside them is not this run's. */
  checkoutRoots(context: QaPlacementContext): string[] {
    const placement = qaPlacement(context);
    if (!placement) return [];
    return context.options.testPlacement
      ? [placement.dataDir, ...(context.options.testPlacement.retainedDataDirs ?? [])]
      : [join(getWorkRoot(), "queue")];
  },
  /** Every root a retention sweep reads: the store's own directory plus the checkout placement's. */
  retentionRoots(context: QaPlacementContext): string[] {
    return [this.isolationDataDir(context), ...this.checkoutRoots(context)];
  },
  /** The layout the detached supervisor derives too, from the same key. */
  qaRepositoryRootPath(context: QaPlacementContext, key: string): string {
    return qaRunRootPath(this.isolationDataDir(context), key);
  },
  qaCheckoutPath(context: QaPlacementContext, key: string, runId: string): string {
    return join(this.qaRepositoryRootPath(context, key), runId);
  },
  /** The recorded external checkout, or the one this run would allocate for itself. */
  checkoutForRun(context: QaPlacementContext, run: ProjectQaRun): string {
    return run.checkoutPath ?? this.qaCheckoutPath(context, run.key, run.id);
  },
  /** Prove a recorded external checkout is exactly the one this run's own allocation names. */
  admitCheckout(context: QaPlacementContext, run: ProjectQaRun): void {
    if (!run.checkoutPath) return;
    const placement = qaPlacement(context);
    const expected = this.checkoutRoots(context).some(root =>
      run.checkoutPath === join(root, "project-qa", digest(run.submittedKey ?? run.key).slice(0, 24), run.id));
    if (!placement || !expected) throw new Error("Project QA checkout allocation identity changed");
    placement.admit(run.checkoutPath);
  },
  /**
   * Where this QA run's temp leaf lives. Live service uses the configured work
   * root; a fixture injects its own mount; a protected store without either keeps
   * the inherited environment so an already-launched run is untouched.
   */
  scratchPlacement(context: QaPlacementContext, run?: ProjectQaRun): RunScratchPlacement | null {
    const namespace = run
      ? context.store.scratchNamespaceFor({ repoPath: run.repository.path, repository: run.repository.origin })
      : undefined;
    if (context.options.runScratch) return namespace ? context.options.runScratch.withNamespace?.(namespace) ?? context.options.runScratch : context.options.runScratch;
    if (liveCheckoutDataDir(this.isolationDataDir(context))) return checkoutRunScratchPlacement({ namespace });
    return null;
  },
  /** Create or re-prove this run's scratch leaf and record it. A run already in flight keeps its recorded path. */
  ensureRunScratch(context: QaPlacementContext, run: ProjectQaRun): string | undefined {
    const placement = this.scratchPlacement(context, run);
    if (!placement) return run.temporaryDirectory;
    const directory = runTemporaryEnvironment(run.id, placement, run.temporaryDirectory).TMPDIR;
    const current = context.store.qaRun(run.id) ?? run;
    if (current.temporaryDirectory !== directory) context.store.putQaRun({ ...current, temporaryDirectory: directory });
    return directory;
  },
  /** Remove the recorded leaf once the run has settled and its checkout is gone. */
  releaseRunScratch(context: QaPlacementContext, run: ProjectQaRun, checkoutRetained: boolean): void {
    if (checkoutRetained || !run.temporaryDirectory) return;
    try {
      const placement = this.scratchPlacement(context, run);
      if (placement) placement.remove(run.temporaryDirectory);
      else removeRecordedRunScratchDirectory(run.temporaryDirectory);
    } catch { /* a leftover leaf is operational, not a settlement failure */ }
  },
};
