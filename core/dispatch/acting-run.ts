/**
 * The run one presented Nucleus ticket acts for.
 *
 * A retained thread keeps one shell across runs: the `NUCLEUS_TICKET` its
 * environment exported at dispatch, the MCP binding its session started with and
 * the helper argv an earlier turn named all outlive the run they were written
 * for. Nucleus therefore proves the *thread*, not the shell variable: when the
 * presented run is no longer the current one and this task's current run belongs
 * to the same proven host thread — the same host and the same agent — the
 * thread's current run acts for it, so a stale environment value never refuses
 * the thread's own work (nucleus#1376, seen live on nucleus#1371).
 *
 * Nothing wider resolves. Another thread's ticket, a task with no current run and
 * a credential its own row has revoked are still refused, and the refusal names
 * the current run and the fix. A proof executor is never resolved across runs:
 * its run is one qualification, and a superseded executor report stays its own
 * run's evidence.
 */
import type { Run, Task } from "../../shared/contracts";
import {
  recordSupersededRunRefusal,
  supersededResumeRefusal,
} from "../recovery/superseded-resume";
import type { Store } from "../store/store";

const REFUSED_KIND = "stale_ticket_unresolved";
const RESOLVED_KIND = "stale_ticket_resolved";

const label = (task: Task) => task.reference ?? task.title;

/** A thread is one agent on one proven host; two runs share it only when both facts match. */
const threadOf = (run: Pick<Run, "agentId" | "hostId">): string | null =>
  run.agentId && run.hostId ? `${run.agentId} on ${run.hostId}` : null;

const sameThread = (
  presented: Pick<Run, "agentId" | "hostId">,
  current: Pick<Run, "agentId" | "hostId">,
): boolean =>
  Boolean(
    presented.agentId &&
      current.agentId &&
      presented.hostId &&
      current.hostId &&
      presented.agentId === current.agentId &&
      presented.hostId === current.hostId,
  );

/** The run id a task's current run holds for this role; recovery keeps its own slot. */
export function currentRunIdFor(
  task: Task,
  presented: Pick<Run, "role"> | null,
): string | null {
  return (
    (presented?.role === "recovery"
      ? task.resolution.recovery?.runId
      : task.resolution.currentRunId) ?? null
  );
}

/** The retained worker's own identity, for the run a task row carries instead of a run row. */
const workerThread = (task: Task): Pick<Run, "agentId" | "hostId"> => ({
  agentId: task.agentId ?? null,
  hostId: task.hostId ?? null,
});

/**
 * The retained line a run belongs to: the initial worker on the task row and its
 * revisions are one line, because they are one thread doing one job. Two runs on
 * different lines are never substituted for each other, so a worker's report can
 * never settle a reviewer's turn on the same workspace.
 */
const threadRole = (run: Pick<Run, "role"> | null): string =>
  run ? (run.role === "revision" ? "worker" : run.role) : "worker";

const live = (run: Run) => !run.released && !run.completion;

/**
 * The same-thread current run, whatever its lease state, or `null`.
 *
 * `presented` is null for the initial worker run, which a task row carries
 * instead of a run row; that run shares the task's own thread and the worker's
 * own line. A caller that owns its own refusal keeps it when this returns
 * nothing.
 */
function resolveThread(
  store: Store,
  task: Task,
  presentedRunId: string,
  presented: Run | null,
  requireLive: boolean,
): Run | null {
  // A run with no row is only ever the task's own durable run id; anything else
  // is an identity this task does not carry.
  if (!presented && presentedRunId !== task.runId) return null;
  const shown = presented ?? workerThread(task);
  const currentId = currentRunIdFor(task, presented);
  if (!currentId || currentId === presentedRunId) return null;
  const current = store.run(currentId);
  if (
    !current ||
    (requireLive && !live(current)) ||
    !sameThread(shown, current) ||
    threadRole(presented) !== threadRole(current)
  )
    return null;
  recordResolution(store, task, presentedRunId, current);
  return current;
}

/**
 * The run a presented report belongs to, whether or not that run has settled.
 *
 * A receipt and its attribution outlive the lease: an identical retry of a
 * report the thread already delivered must find the run that settled it, not be
 * refused for a stale shell. Acceptance still applies every liveness rule after
 * this answers, so a settled run never acquires a second result.
 */
export function reportRunFor(
  store: Store,
  task: Task,
  runId: string,
): Run | null {
  const presented = store.run(runId);
  if (presented?.role === "executor") return presented;
  // Nothing resolves: the presented run stays the one that answers, and every
  // acceptance rule then applies to it exactly as before this owner existed.
  return resolveThread(store, task, runId, presented, false) ?? presented;
}

/**
 * The run a presented ticket acts for, or `null` when it does not resolve.
 *
 * It resolves only the shape this owner exists for: the presented run is not
 * current, and the task's current run is live and belongs to the same proven
 * host thread. Every other shape returns `null`, so a caller that owns its own
 * refusal (an ask's superseded-owner text, for one) keeps it.
 */
export function threadRunFor(
  store: Store,
  task: Task,
  runId: string,
): Run | null {
  const presented = store.run(runId);
  if (presented?.role === "executor") return null;
  return resolveThread(store, task, runId, presented, true);
}

/**
 * The run a presented ticket acts for, or a refusal naming why it cannot.
 *
 * The credential itself is authenticated by the caller: this function never
 * accepts one, it only decides which run of that credential's thread the request
 * speaks for. It returns the presented run unchanged when that run is current,
 * and the thread's current run when the presented one has been released or
 * superseded behind a stale shell.
 */
export function actingRunFor(
  store: Store,
  task: Task,
  runId: string,
): Run | null {
  const presented = store.run(runId);
  // A proof executor's run is one qualification; a superseded executor report is
  // kept as that run's own evidence, never moved onto another run.
  if (presented?.role === "executor") return presented;
  const currentId = currentRunIdFor(task, presented);
  if (currentId === runId) return presented;
  const resolved = resolveThread(store, task, runId, presented, true);
  if (resolved) return resolved;
  // Nothing supersedes this identity: leave it to the caller's own rules. The
  // initial worker's durable run id has no run row and no current run, and its
  // own binding decides — this owner only resolves a superseded one.
  if (!presented && !currentId) return null;
  throw refuse(
    store,
    task,
    presented,
    runId,
    currentId ? store.run(currentId) : null,
  );
}

function recordResolution(
  store: Store,
  task: Task,
  presentedRunId: string,
  current: Run,
): void {
  const key = `actingRun:${presentedRunId}:${current.id}`;
  if (store.getMeta(key)) return;
  store.setMeta(key, { at: new Date().toISOString() });
  store.event(
    task.id,
    RESOLVED_KIND,
    `run ${presentedRunId} ticket: resolved to this thread's current run ${current.id} (${threadOf(current)}); set NUCLEUS_TICKET to the current run's ticket path to stop relying on the resolution`,
  );
}

/**
 * The refusal for a ticket that cannot resolve. It names the run in force now —
 * or says the task has none — and the one action that settles it, because a
 * refusal that names no exit is the stuck state this owner exists to remove.
 */
function refuse(
  store: Store,
  task: Task,
  presented: Run | null,
  runId: string,
  current: Run | null,
): Error {
  const thread = threadOf(presented ?? workerThread(task)) ?? "an unproven thread";
  if (current) {
    const refusal = `Stale Nucleus assignment: this ticket names run ${runId} of thread ${thread}, but ${label(task)} is on run ${current.id} of thread ${threadOf(current) ?? "an unproven thread"}. Nothing was applied. Use the ticket path named in the current run ${current.id}'s dispatch or continuation prompt.`;
    recordOnce(store, task, runId, current.id, refusal);
    return new Error(refusal);
  }
  if (task.resolution.prePrResumeInstruction) {
    recordSupersededRunRefusal(store, task.id, runId);
    return new Error(supersededResumeRefusal(runId));
  }
  const refusal = `Stale Nucleus assignment: this ticket names run ${runId} of thread ${thread}, which is no longer current for ${label(task)}, and the task has no current run, so nothing was applied. Resume or restart the task from Nucleus, then use the ticket path its own prompt names.`;
  recordOnce(store, task, runId, null, refusal);
  return new Error(refusal);
}

function recordOnce(
  store: Store,
  task: Task,
  presentedRunId: string,
  currentRunId: string | null,
  detail: string,
): void {
  const key = `actingRunRefused:${presentedRunId}:${currentRunId ?? "none"}`;
  if (store.getMeta(key)) return;
  store.setMeta(key, { at: new Date().toISOString() });
  store.event(task.id, REFUSED_KIND, detail);
}
