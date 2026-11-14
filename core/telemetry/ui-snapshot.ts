import type { Task, TaskSummary, Run, LaneView, Project, HostRunInternalRecord, BoardQaRun, HeavyRunView, ProjectQaRun } from "../../shared/contracts";
import { visibleTaskSummaries } from "../../shared/contracts";
import type { Store } from "../store/store";
import { taskWaitStateContext, queuedReason } from "../recovery/wait-context";
import { boardQaRuns, createQaStalenessResolver } from "../qa/qa-board";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * A launched run past its own run timeout is not live work: its holder vanished without settling
 * (464 leaked Effigy admission records, 2026-11-01). The board leaves it out; settling it is the
 * scheduler's job, not the projection's.
 */
export function overdueHostRun(run: Pick<HostRunInternalRecord, "state" | "launchedAt" | "runTimeoutMs">, nowMs: number): boolean {
  return run.state !== "queued" && run.launchedAt !== null && run.runTimeoutMs !== null
    && Date.parse(run.launchedAt) + run.runTimeoutMs < nowMs;
}

/**
 * The task one live host run belongs to: its working directory is inside the
 * task's retained workspace, or its scheduler id matches that task's proof
 * execution. The board strip and the live-run presence read the same rule, so a
 * run shows up in the same place in both.
 */
export function taskForHostRun(tasks: readonly Task[], hostRun: Pick<HostRunInternalRecord, "id" | "effigyRunId" | "repository">): Task | undefined {
  return tasks.find(task => {
    const path = hostRun.repository.path;
    if (task.directory && isAbsolute(path)) {
      const rel = relative(resolve(task.directory), resolve(path));
      if (rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))) return true;
    }
    return task.proofExecutions.some(proof => proof.runId === hostRun.id || proof.runId === hostRun.effigyRunId);
  });
}

export interface UiSnapshotFacts {
  revision: number;
  tasks: Task[];
  capacityTasks: Task[];
  summaries: TaskSummary[];
  projects: Project[];
  runs: Run[];
  unsettledNotices: number;
  lanes: LaneView[];
  /** Milestone QA cards (Tom, 2026-11-01); task test runs stay on their task card as `heavyRun`. */
  qaRuns: BoardQaRun[];
  queuedCounts: Array<{ repoPath: string; count: number }>;
}

/**
 * One compact projection per durable store revision. Concurrent RPCs execute in
 * the same plugin process, so publishing the completed immutable projection is
 * enough to coalesce every later poll until a relevant durable write advances
 * the revision.
 */
export function createUiSnapshotFactsCache(store: Store, slotAdmissionReader: (tasks: Task[], runs: Run[]) => (task: Task) => string = () => () => "", liveHostRuns: () => HostRunInternalRecord[] = () => [], latestQaRuns: (nowMs: number) => ProjectQaRun[] = () => [], externalWait: (task: Task) => string = () => '', externalWaitSignature: () => string = () => '', defaultHostId: () => string = () => '') {
  const staleQaRun = createQaStalenessResolver();
  let cached: UiSnapshotFacts | null = null;
  let liveSignature: string | null = null;
  let lastStoreRevision = store.boardRevision();
  let projectionRevision = lastStoreRevision;
  return (): UiSnapshotFacts => {
    const storeRevision = store.boardRevision();
    const currentLive = liveHostRuns();
    const nowMs = Date.now();
    const boardHostId = defaultHostId();
    const qaRuns = boardQaRuns(latestQaRuns(nowMs), nowMs, staleQaRun);
    // A passing QA card fades on the clock, with no write: a change in the visible cards advances the revision.
    const signature = JSON.stringify([currentLive.filter(run => run.runClass === "heavy")
      .map(run => [run.id, run.state, run.position, run.selector, run.submittedAt, run.launchedAt, run.repository.path])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))), qaRuns.map(run => [run.id, run.stale]), externalWaitSignature(), boardHostId]);
    if (storeRevision !== lastStoreRevision || liveSignature !== null && liveSignature !== signature)
      projectionRevision = Math.max(projectionRevision + 1, storeRevision);
    else projectionRevision = Math.max(projectionRevision, storeRevision);
    lastStoreRevision = storeRevision;
    liveSignature = signature;
    const revision = projectionRevision;
    if (cached?.revision === revision) return cached;
    const tasks = store.boardTasks(5);
    const capacityTasks = store.admissionCandidates();
    const projects = store.projects();
    const runs = store.runsForTasks([...new Set([...tasks, ...capacityTasks].map(task => task.id))]);
    // Spec 043 (a): the newest open decision linked to each task names its
    // `needs_operator_input` wait without shipping the decision in the board.
    const decisionByTask = new Map<string, string>();
    for (const decision of store.listDecisions({ status: "open" })) for (const taskId of decision.links.tasks) if (!decisionByTask.has(taskId)) decisionByTask.set(taskId, decision.id);
    const slotAdmissionReason = slotAdmissionReader(capacityTasks, runs);
    const waitContexts = new Map(tasks.map(task => [task.id,
      taskWaitStateContext(store, task, decisionByTask.get(task.id) ?? null, slotAdmissionReason)]));
    const displayTasks = tasks.map(task => ({ ...task, reason: queuedReason(store, task, waitContexts.get(task.id)!, externalWait) }));
    const taskForRun = (hostRun: HostRunInternalRecord) => taskForHostRun(tasks, hostRun);
    const live = currentLive.filter((run): run is HostRunInternalRecord & { state: "queued" | "admitted" | "running" } =>
      run.runClass === "heavy" && run.state !== "settled" && !overdueHostRun(run, Date.now())).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
    const firstHolder = live.find(run => run.state === "running" || run.state === "admitted");
    const holderTask = firstHolder ? taskForRun(firstHolder) : undefined;
    // Only task-attached runs reach a task card; a milestone QA run has no task and is its own card.
    const heavyByTask = new Map<string, HeavyRunView>();
    for (const run of live) {
      const task = taskForRun(run);
      if (!task || heavyByTask.has(task.id)) continue;
      heavyByTask.set(task.id, { selector: run.selector, state: run.state, position: run.position, submittedAt: run.submittedAt, launchedAt: run.launchedAt,
        holder: run.state === "queued" && firstHolder ? holderTask?.reference ?? "milestone QA" : null });
    }
    cached = {
      revision,
      tasks,
      capacityTasks,
      summaries: visibleTaskSummaries(displayTasks, projects, runs, decisionByTask, waitContexts, boardHostId,
        new Map(displayTasks.map(task => [task.id, store.eventsAll(task.id)])),
        new Map(displayTasks.map(task => [task.id, store.canonicalRepository(task.repoPath, task.repository)]))).map(summary => {
        const heavyRun = heavyByTask.get(summary.id);
        return heavyRun ? { ...summary, heavyRun } : summary;
      }),
      projects,
      runs,
      unsettledNotices: store.unsettledNoticeCount(),
      // Lane views derive from lanes, outcomes and live tasks, and carry their own
      // revision, so they are reused across a board rebuild that touched neither.
      lanes: store.laneViews(),
      qaRuns,
      queuedCounts: store.boardQueueCounts(),
    };
    return cached;
  };
}
