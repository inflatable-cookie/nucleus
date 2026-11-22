import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_RETENTION_MS, type Store } from "../store/store";
import {
  assertWorkPlacementAvailable,
  liveWorkPlacement,
} from "../workspaces/checkout-volume";
import { getWorkPlacement } from "../workspaces/work-root.mjs";
import type { ProjectQaRun } from "../../shared/contracts";

function needsTeardownRetry(run: ProjectQaRun): boolean {
  const lastTeardown = run.steps
    .filter((step) => step.name === "teardown")
    .at(-1);
  return (
    run.failedStep === "teardown" ||
    Boolean(
      lastTeardown &&
        (lastTeardown.exitCode !== 0 ||
          lastTeardown.signal != null ||
          lastTeardown.timedOut ||
          lastTeardown.terminationError != null ||
          lastTeardown.processGroupEmpty === false),
    )
  );
}

/**
 * Keep the existing legacy evidence expiry. This sweep never handles checkout or
 * process custody. The live store's history is read in its configured
 * `projectQaRoot` and in the retired `queue/project-qa` location while it is still
 * there; a private data directory keeps its own `project-qa/`.
 */
export async function pruneLegacyQaEvidence(
  store: Store,
  dataDir: string,
): Promise<void> {
  const live = liveWorkPlacement(dataDir);
  const evidence: string[] = [join(dataDir, "project-qa")];
  if (live) {
    try {
      assertWorkPlacementAvailable(getWorkPlacement(dataDir));
      evidence.push(live.projectQaRoot);
      if (live.retired.projectQaRoot) evidence.push(live.retired.projectQaRoot);
    } catch {
      /* The volume must be verified before expiry can remove anything. */
    }
  }
  const cutoff = Date.now() - HISTORY_RETENTION_MS;
  for (const root of new Set(evidence)) {
    if (!(await lstat(root).catch(() => null))?.isDirectory()) continue;
    for (const key of await readdir(root, { withFileTypes: true })) {
      if (!key.isDirectory() || !/^[a-f0-9]{24}$/.test(key.name)) continue;
      const directory = join(root, key.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const match =
          /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(?:retry-\d+\.)?(?:.*\.(?:log|json)|(?:stdout|stderr)\.log)$/.exec(
            entry.name,
          );
        if (!entry.isFile() || !match) continue;
        const id = match[1];
        const run = store.qaRun(id);
        if (
          run &&
          (!run.finishedAt ||
            Date.parse(run.finishedAt) >= cutoff ||
            run.state === "running" ||
            run.state === "queued" ||
            run.checkoutCleanupPending ||
            (needsTeardownRetry(run) && store.latestQaRun(run.key)?.id === id))
        )
          continue;
        const host = store.hostRun(id);
        if (host && host.state !== "settled") continue;
        const path = join(directory, entry.name);
        try {
          const info = await lstat(path);
          if (info.isFile() && info.mtimeMs < cutoff) await unlink(path);
        } catch {
          /* Keep uncertain evidence for the next sweep. */
        }
      }
    }
  }
}
