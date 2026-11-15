/**
 * Task 104/191: retention for settled milestone QA runs. A run's Queue-owned
 * checkout is removed once nothing owns it any more; its per-run logs and
 * result sidecars expire with retained history; an unsettled, retryable or
 * active run keeps both. The sweep runs on the service's own hourly retention
 * pass, never on a board read.
 */
import { join } from "node:path";
import { projectQaRunSchema, type ProjectQaRun } from "../../shared/contracts";
import { HISTORY_RETENTION_MS, type Store } from "../store/store";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { removeQaWorkspace } from "./project-qa-worktree";
import { projectQaFilePruning } from "./project-qa-supervision-files";
import { projectQaPlacement } from "./project-qa-placement";
import { digest } from "../store/store";
import type { ProjectQaOptions } from "./project-qa-context";

/** True when the run's last recorded teardown failed or is still uncertain. */
export function needsTeardownRetry(run: ProjectQaRun): boolean {
  const lastTeardown = run.steps.filter(step => step.name === "teardown").at(-1);
  return run.failedStep === "teardown" || Boolean(lastTeardown && (lastTeardown.exitCode !== 0 || lastTeardown.signal != null
    || lastTeardown.timedOut || lastTeardown.terminationError != null || lastTeardown.processGroupEmpty === false));
}

export interface QaRetentionContext {
  store: Store;
  hostRuns: Pick<HostRunScheduler, "get">;
  options: Pick<ProjectQaOptions, "dataDir" | "testPlacement" | "runScratch">;
  isolationDataDir(): string;
}

/** One throttle per runner, so a new process always takes one sweep. */
export class ProjectQaRetention {
  private lastCheckoutRetentionAt = 0;
  constructor(private readonly runner: QaRetentionContext) {}

  /** Remove settled checkouts and expire per-run files; at most once an hour per runner. */
  async sweep(): Promise<void> {
    if (Date.now() - this.lastCheckoutRetentionAt < 60 * 60 * 1000) return;
    this.lastCheckoutRetentionAt = Date.now();
    const { store } = this.runner;
    const rows = store.db.prepare("SELECT data FROM project_qa_runs WHERE json_valid(data)").all() as { data: string }[];
    const roots = [
      this.runner.isolationDataDir(),
      ...projectQaPlacement.retentionRoots({ store, options: this.runner.options })];
    for (const row of rows) {
      let run: ProjectQaRun;
      try { run = projectQaRunSchema.parse(JSON.parse(row.data)); } catch { continue; }
      if (run.state === "queued" || run.state === "running" || !run.finishedAt || run.checkoutCleanupPending) continue;
      const keyDigest = digest(run.submittedKey ?? run.key).slice(0, 24);
      const expected = roots.map(root => join(root, "project-qa", keyDigest, run.id));
      const checkout = expected.find(path => path === run.checkoutPath)
        ?? expected.find(path => (!run.checkoutPath || run.checkoutPath.endsWith(`/project-qa/${keyDigest}/${run.id}`))
          && path === projectQaPlacement.qaCheckoutPath({ store, options: this.runner.options }, run.key, run.id));
      if (!checkout) continue;
      if (needsTeardownRetry(run) && store.latestQaRun(run.key)?.id === run.id) continue;
      const hostRun = this.runner.hostRuns.get(run.id);
      if (hostRun && hostRun.state !== "settled") continue;
      try {
        await removeQaWorkspace({ registeredPath: run.repository.path, checkoutPath: checkout });
      } catch { /* Preserve uncertain checkouts; a later sweep retries. */ }
    }
    await projectQaFilePruning.pruneQaFiles.call({
      store, hostRuns: this.runner.hostRuns, historyRetentionMs: HISTORY_RETENTION_MS,
      needsTeardownRetry,
    }, roots);
  }
}
