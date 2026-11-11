import type { BuildOutputCleanup } from "../../shared/contracts";

/** Shared prefix for a task's cleanup reason when build output is retained. */
export const buildOutputCleanupReasonPrefix = "Build output cleanup blocked: ";

type RecordState = BuildOutputCleanup["state"];

/**
 * Run-bound record (Queue #342). Written with the authenticated completion of an
 * author, revision or reviewer run, so a run only ever becomes a deletion
 * candidate after its own result is recorded. Old runs never gain a record.
 */
export function runBuildOutputIntent(cleanups: BuildOutputCleanup[], run: { id: string; workspaceId: string; agentId: string | null }, directory: string, at: string): BuildOutputCleanup[] {
  const others = cleanups.filter(item => !(item.runId === run.id && item.workspaceId === run.workspaceId));
  return [...others, {
    workspaceId: run.workspaceId, directory, runId: run.id, ...(run.agentId ? { agentId: run.agentId } : {}),
    state: "intent", detail: "Awaiting settlement of the run's agent and later runs in this workspace", at,
  }];
}

/** Settles one run-bound record. Other records and the run's history are untouched. */
export function recordRunBuildOutput(cleanups: BuildOutputCleanup[], runId: string, workspaceId: string, state: RecordState, detail: string, at: string): BuildOutputCleanup[] {
  return cleanups.map(item => item.runId === runId && item.workspaceId === workspaceId ? { ...item, state, detail, at } : item);
}

/**
 * A terminal workspace removal with every thread idle proves the same directory
 * holds nothing left for its earlier run-bound records.
 */
export function coverRunBuildOutput(cleanups: BuildOutputCleanup[], workspaceId: string, directory: string, at: string): BuildOutputCleanup[] {
  return cleanups.map(item => item.runId && item.workspaceId === workspaceId && item.directory === directory && item.state !== "complete"
    ? { ...item, state: "complete" as const, detail: "Covered by the settled workspace build output cleanup", at }
    : item);
}

/**
 * The task's cleanup reason names every retained (skipped or uncertain) root. A
 * reason written by a different owner is left alone; only Queue's own prefixed
 * reason is recomputed.
 */
export function cleanupReasonFor(current: string, cleanups: BuildOutputCleanup[]): string {
  const retained = cleanups.filter(item => item.state === "skipped" || item.state === "uncertain");
  if (retained.length) return `${buildOutputCleanupReasonPrefix}${retained.map(item => item.detail).join("; ")}`;
  return current.startsWith(buildOutputCleanupReasonPrefix) ? "" : current;
}
