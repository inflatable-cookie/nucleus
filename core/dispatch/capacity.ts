import { DEFAULT_PROJECT_LIMIT, DEFAULT_PAPERCUT_PROJECT_LIMIT } from "../../shared/contracts";
import { currentTaskStop, holdsOf, isDispositionActive, mergeHeld, runHoldsSlot, type Run, type Task } from "../../shared/contracts";
import { DEFAULT_GLOBAL_LIMIT, formatTaskNumber, isParkedTask } from "../../shared/contracts";
import { routeUnavailableStop } from "../../shared/task-stop";
import { CAPACITY_WAIT_PREFIX, inFlightSlotWaitReason } from "../../shared/wait-state";
import type { Resolution } from "../resolution";
import type { Store } from "../store/store";

/**
 * Project and global occupancy, in a module both the engine and the resolution can use.
 *
 * A ruling is not a resource request: an operator deciding that a lane should continue
 * must not be refused because the project is momentarily full. The decision applies, and
 * the dispatch waits for a slot - so this has to be readable from the resolution, which
 * cannot import the engine without a cycle.
 */
type CapacityTask = Task & { hasUnreleasedRun?: boolean; hasLiveRun?: boolean };

/** A dispatch fence blocks fresh task-work launches. A merge fence does not. */
export const dispatchBlocked = (task: Task) => Boolean(holdsOf(task).dispatch);
export const DISPATCH_HELD_REASON = "Dispatch held; release to continue";

/** Count only nonterminal tasks that own, or are creating, a Queue workspace. */
export function holdsQueueWorkspace(task: Task): boolean {
  return !["done", "cancelled"].includes(task.phase) && !task.removedAt &&
    task.reviewEntry?.preserveWorkspace !== true &&
    Boolean(task.workspaceId || task.workspaceIntent || task.reviewEntry?.workspaceId);
}

export function projectInFlightWaitReason(task: Task, tasks: Task[], projectKeyFor: (task: Task) => string | null,
  limitFor: (task: Task) => number): string {
  // This gate is only for a first dispatch that creates Queue-owned work.
  // Review-entry admission binds no workspace, so it never waits here.
  if (task.phase !== "queued" || slotRequestFenced(task) || task.workspaceId || task.workspaceIntent || task.reviewEntry) return "";
  const projectKey = projectKeyFor(task);
  if (!projectKey) return "";
  // Parked faults and explicit holds keep their workspaces and ownership, but
  // cannot advance until an owner acts. They must not exhaust first-dispatch
  // admission indefinitely. A live or starting agent still counts in any phase.
  const count = tasks.filter(candidate => holdsQueueWorkspace(candidate) && projectKeyFor(candidate) === projectKey &&
    (occupiesSlot(candidate) || !slotRequestFenced(candidate) && !["blocked", "error", "needs_attention"].includes(candidate.phase))).length;
  const limit = limitFor(task);
  return count >= limit ? `Waiting: ${count} of ${limit} tasks in flight for this project` : "";
}

/**
 * A request with an explicit stop or hold cannot launch until its fence clears.
 * Keep this shared by occupancy and request ordering: a parked task that cannot
 * launch should neither reserve a slot nor rank ahead of runnable work.
 */
export function slotRequestFenced(task: Task): boolean {
  const stop = currentTaskStop(task)?.reason;
  return dispatchBlocked(task) || isDispositionActive(task)
    || ["held", "operator_needed", "interactive", "responsible_question", "escalated", "budget"].includes(stop ?? "")
    || (mergeHeld(task) && task.phase === "verifying");
}

/**
 * A worker turn holds a slot while its agent is live or starting (Spec 058,
 * task 629; Tom, 2026-11-03: slots count live agents).
 */
const workerHoldsSlot = (task: Task): boolean => {
  // An interactive session pins its operator-attached agent for the session.
  if (task.interactive === true) return true;
  // Observed live, whatever the phase or report state.
  if (task.agentActive === true) return true;
  if (task.agentIntent && !task.completion) {
    // Intent recorded but the agent never arrived: the launch is starting.
    if (!task.agentId) return true;
    // Launched but never observed idle or dead, with no report: still starting.
    if (task.agentActive !== false) return true;
  }
  // Dispatch is the starting state: workspace creation and the agent launch run
  // in one flow (creation, then the launch intent, then the agent), so the whole
  // dispatch window keeps the serialization the slot check inside the dispatch
  // transaction relies on. A fenced or reported dispatch holds nothing.
  if (task.phase === "dispatching" && !task.completion && !slotRequestFenced(task)) return true;
  return false;
};

// Slots count live agents: a task holds a slot only while one of its agents is
// live or starting. A task with no running agent that is only waiting on hosted
// checks, the repository integration (merge) turn, mechanical verification, a
// thread release or settlement holds no slot; it keeps its merge order, and when
// it next needs an agent it requests a slot through the ordinary fair-share
// order. Terminal tasks never hold slots.
export const occupiesSlot = (task: CapacityTask, runs: Run[] = []) =>
  !["done", "cancelled"].includes(task.phase) &&
  (workerHoldsSlot(task) || runs.some(runHoldsSlot) || task.hasLiveRun === true);

/** Never-dispatched `queued` work. Every other slot request is in-flight. */
function isInFlightSlotRequest(task: Task): boolean {
  return task.phase !== "queued" && !slotRequestFenced(task);
}

/** Priority globally, oldest first on per-project ties, round-robin across projects. */
function fairShareSlotOrder(requestsOldestFirst: Task[]): Task[] {
  const projects = new Map<string, Task[]>();
  for (const task of requestsOldestFirst) {
    const queue = projects.get(task.repoPath) ?? [];
    queue.push(task);
    projects.set(task.repoPath, queue);
  }
  for (const queue of projects.values()) queue.sort((a, b) => b.queuePriority - a.queuePriority);
  const order = [...projects.keys()];
  const offsets = new Map(order.map(project => [project, 0]));
  const result: Task[] = [];
  let cursor = 0;
  while (result.length < requestsOldestFirst.length) {
    const priority = Math.max(...order.flatMap(project => {
      const task = projects.get(project)![offsets.get(project)!];
      return task ? [task.queuePriority] : [];
    }));
    let selected = -1;
    for (let step = 0; step < order.length; step++) {
      const index = (cursor + step) % order.length;
      const project = order[index];
      if (projects.get(project)![offsets.get(project)!]?.queuePriority === priority) {
        selected = index;
        break;
      }
    }
    if (selected < 0) break;
    const project = order[selected];
    result.push(projects.get(project)![offsets.get(project)!] as Task);
    offsets.set(project, offsets.get(project)! + 1);
    cursor = (selected + 1) % order.length;
  }
  return result;
}

/**
 * In-flight requests rank ahead of never-dispatched queued requests. Within
 * each tier, priority is global and equal priorities retain project fair share.
 */
export function fairSlotRequestOrder(tasksNewestFirst: Task[], isRequest: (task: Task) => boolean): Task[] {
  const requests = tasksNewestFirst.toReversed().filter(task => isRequest(task) && !slotRequestFenced(task));
  return [
    ...fairShareSlotOrder(requests.filter(isInFlightSlotRequest)),
    ...fairShareSlotOrder(requests.filter(task => !isInFlightSlotRequest(task))),
  ];
}

/**
 * Which queued tasks one dispatch pass needs to visit. A queued task is not active
 * work, so a pass looks at the front of each project's queue: as many as have a
 * free slot, plus a small margin so the next in line shows its wait. A task behind
 * an unfinished prerequisite takes no place. It is visited only to record that wait
 * once. Tom, 2026-11-06: "The number of queued tasks shouldn't make a difference".
 */
export const QUEUED_VISIT_MARGIN = 2;
export function queuedVisits(order: Task[], occupied: Task[], projectLimitFor: (task: Task) => number, papercuts: PapercutDispatchPolicy,
  prerequisiteWaitToRecord: (task: Task) => "none" | "recorded" | "record", globalLimit = Number.POSITIVE_INFINITY): { start: Task[]; rest: Task[] } {
  const occupiedByPool = new Map<string, number>();
  for (const task of occupied) {
    const key = slotPoolKey(task, papercuts);
    occupiedByPool.set(key, (occupiedByPool.get(key) ?? 0) + 1);
  }
  const visitedByPool = new Map<string, number>();
  // `start` holds the tasks walking the order would admit, so starting them together
  // keeps the order's outcome. `rest` shows its wait after them.
  const start: Task[] = [], rest: Task[] = [];
  let globalFree = globalLimit - occupied.length;
  for (const task of order) {
    const wait = prerequisiteWaitToRecord(task);
    if (wait === "record") rest.push(task);
    if (wait !== "none") continue;
    const key = slotPoolKey(task, papercuts);
    const free = Math.max(0, slotPoolLimit(task, projectLimitFor(task), papercuts) - (occupiedByPool.get(key) ?? 0));
    const visited = visitedByPool.get(key) ?? 0;
    if (visited >= free + QUEUED_VISIT_MARGIN) continue;
    visitedByPool.set(key, visited + 1);
    if (visited < free && globalFree > 0) { globalFree--; start.push(task); }
    else rest.push(task);
  }
  return { start, rest };
}

export const isPapercutTask = (task: Task) => task.papercutTask || task.planningSource?.kind === "papercut";
type PapercutDispatchPolicy = { limit: number; projectKeyFor: (task: Task) => string };
const defaultPapercutPolicy: PapercutDispatchPolicy = { limit: DEFAULT_PAPERCUT_PROJECT_LIMIT, projectKeyFor: task => task.repoPath };
const slotPoolKey = (task: Task, papercuts: PapercutDispatchPolicy) => JSON.stringify(
  isPapercutTask(task) ? ["papercut", papercuts.projectKeyFor(task)] : ["normal", task.repoPath]);
const slotPoolLimit = (task: Task, projectLimit: number, papercuts: PapercutDispatchPolicy) =>
  isPapercutTask(task) ? papercuts.limit : projectLimit;

export function recoveryCapacityFor(task: Task, tasks: Task[], globalLimit: number, projectLimit: number = DEFAULT_PROJECT_LIMIT,
  papercuts: PapercutDispatchPolicy = defaultPapercutPolicy) {
  const occupied = tasks.filter(task => occupiesSlot(task));
  if (occupied.length >= globalLimit) return "Global concurrent task-slot limit reached";
  const key = slotPoolKey(task, papercuts);
  if (occupied.filter(t => slotPoolKey(t, papercuts) === key).length >= slotPoolLimit(task, projectLimit, papercuts))
    return isPapercutTask(task) ? "Project papercut task-slot limit reached" : "Project concurrent task-slot limit reached";
  return "";
}

export function capacityFor(task: Task, tasks: Task[], globalLimit: number, projectLimit: number = DEFAULT_PROJECT_LIMIT,
  papercuts: PapercutDispatchPolicy = defaultPapercutPolicy) {
  return recoveryCapacityFor(task, tasks, globalLimit, projectLimit, papercuts);
}

interface SlotAdmissionView {
  tasks: Task[];
  runsByTask: Map<string, Run[]>;
  globalLimit: number;
  projectLimitFor: ReturnType<Store['projectDispatchLimitResolver']>;
  papercuts: ReturnType<Store['papercutDispatchPolicy']>;
  dependencyWait: (task: Task) => string;
  integrationReady: (task: Task) => boolean;
  /** One board batch ranks its fixed tasks once; `requests` holds that ranking. */
  requestFlags?: Map<string, boolean>;
  requests?: Task[];
}
export type { SlotAdmissionView };

/** A prerequisite wait or an already occupied slot needs no admission. */
function slotAdmissionExempt(task: Task, current?: Task, runs: Run[] = []): boolean {
  return Boolean(task.phase === 'changes_requested' && task.prerequisiteWait?.releasedAt) ||
    Boolean(task.prerequisiteWait && !task.prerequisiteWait.releasedAt) ||
    Boolean(current && occupiesSlot(current, runs));
}

/** Decide whether a candidate requests a slot from the facts read so far. */
export function slotRequestDecision(candidate: Task, parkedPhases: readonly string[], includeRecovery: boolean,
  facts: { integrationReady?: boolean; routingRetryAllowed?: boolean; dependencyWait?: string } = {}): boolean | 'read' {
  if (dispatchBlocked(candidate) || isDispositionActive(candidate) || occupiesSlot(candidate)) return false;
  if (mergeHeld(candidate) && candidate.phase === 'verifying') return false;
  if (candidate.phase === 'verifying' && !candidate.resolution.mergedCommit && candidate.resolution.integrationTurn) {
    if (facts.integrationReady === undefined) return 'read';
    if (!facts.integrationReady) return false;
  }
  if (routeUnavailableStop(candidate)) {
    if (facts.routingRetryAllowed === undefined) return 'read';
    if (!facts.routingRetryAllowed) return false;
  }
  if (candidate.phase === 'queued') return facts.dependencyWait === undefined ? 'read' : !facts.dependencyWait;
  if (candidate.prerequisiteWait && !candidate.prerequisiteWait.releasedAt) return false;
  if (isParkedTask(candidate) && parkedPhases.includes(candidate.phase)) return true;
  return includeRecovery && candidate.phase === 'needs_attention' && Boolean(candidate.resolution.recovery) && !candidate.resolution.recoveryActive;
}

/** Decide a slot wait from a snapshot of capacity and eligible requests. */
export function decideSlotAdmission(task: Task, tasks: Task[], globalLimit: number,
  projectLimitFor: (task: Task) => number, papercuts: PapercutDispatchPolicy,
  capacity: string, requests: Task[], waiters: Task[]): string {
    if (capacity) {
      // Running work fills the pool: name its occupancy against the limit, and
      // list in-flight waiters that hold no slot (checks, merge turn, thread
      // release) separately so they stay visible.
      const key = slotPoolKey(task, papercuts);
      const sameScope = (candidate: Task) => capacity.startsWith("Global") || slotPoolKey(candidate, papercuts) === key;
      const occupants = tasks.filter(candidate => occupiesSlot(candidate) && sameScope(candidate));
      const limit = capacity.startsWith("Global") ? globalLimit : slotPoolLimit(task, projectLimitFor(task), papercuts);
      const label = (candidate: Task) => candidate.number
        ? `${candidate.repository && candidate.repository !== task.repository ? `${candidate.repository}#` : "#"}${formatTaskNumber(candidate.number)}` : candidate.id;
      const labels = occupants.map(label).join(", ");

      const waiterLabels = waiters.map(label).join(", ");
      const counts = ` (${occupants.length}/${limit} occupied${labels ? `: ${labels}` : ""}${waiterLabels ? `; ${waiters.length} waiting without a slot: ${waiterLabels}` : ""})`;
      return `${CAPACITY_WAIT_PREFIX} ${capacity}${counts}`;
    }
    const occupied = tasks.filter(candidate => occupiesSlot(candidate));
    let globalAvailable = globalLimit - occupied.length;
    const occupiedByProject = new Map<string, number>();
    for (const candidate of occupied) {
      const key = slotPoolKey(candidate, papercuts);
      occupiedByProject.set(key, (occupiedByProject.get(key) ?? 0) + 1);
    }
    // Actual occupancy, before earlier requests reserve the free slots below.
    const runningByProject = new Map(occupiedByProject);
    const inFlightAhead: Task[] = [];
    let queuedAhead = 0;
    for (const request of requests) {
      const key = slotPoolKey(request, papercuts);
      const projectAvailable = slotPoolLimit(request, projectLimitFor(request), papercuts) - (occupiedByProject.get(key) ?? 0);
      if (request.id === task.id) {
        if (globalAvailable > 0 && projectAvailable > 0) return '';
        if (inFlightAhead.length > 0) {
          const labels = inFlightAhead.map(candidate => candidate.number
            ? `${candidate.repository && candidate.repository !== task.repository ? `${candidate.repository}#` : "#"}${formatTaskNumber(candidate.number)}` : candidate.id);
          return inFlightSlotWaitReason(inFlightAhead.length, labels);
        }
        if (globalAvailable <= 0) return `${CAPACITY_WAIT_PREFIX} Waiting behind ${queuedAhead} earlier queued reservations (${occupied.length}/${globalLimit} global slots occupied)`;
        if (projectAvailable <= 0) {
          // Name the real numbers: the limit can be met by earlier requests'
          // reservations rather than by running work (papercut 1d72cbab).
          const limit = slotPoolLimit(request, projectLimitFor(request), papercuts), running = runningByProject.get(key) ?? 0;
          const reserved = (occupiedByProject.get(key) ?? 0) - running;
          const occupants = tasks.filter(candidate => occupiesSlot(candidate) && slotPoolKey(candidate, papercuts) === key);
          const labels = occupants.map(candidate => candidate.number ? `${candidate.repository && candidate.repository !== task.repository ? `${candidate.repository}#` : "#"}${formatTaskNumber(candidate.number)}` : candidate.id).join(', ');
          const counts = ` (${running}/${limit} occupied${labels ? `: ${labels}` : ''}${reserved > 0 ? `, ${reserved} reserved by earlier requests` : ''})`;
          return `${isPapercutTask(request) ? 'Waiting for a project slot… Project papercut task-slot limit reached' : 'Waiting for a project slot… Project concurrent task-slot limit reached'}${counts}`;
        }
        return '';
      }
      if (globalAvailable > 0 && projectAvailable > 0) {
        globalAvailable--;
        if (request.phase === "queued") queuedAhead++;
        occupiedByProject.set(key, (occupiedByProject.get(key) ?? 0) + 1);
      }
      if (isInFlightSlotRequest(request)) inFlightAhead.push(request);
    }
    return '';
}

/**
 * Why a task has no slot now: fair-share admission, its board batch and the facts
 * one dispatch pass reads once. Same-name `Resolution` methods delegate here, and
 * `slotAdmissionReason` and `holdsIntegrationTurn` go back through them so instance
 * overrides fire. `store` reads the resolution per call.
 */
export class SlotAdmission {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  private dispatchPassFacts: Pick<SlotAdmissionView, 'integrationReady' | 'dependencyWait'> | null = null;
  private dispatchPassDepth = 0;
  /**
   * One dispatch pass asks every queued task's admission, and each answer ranks
   * every other request, so uncached prerequisite and integration reads cost the
   * square of the queue: 410 queued Project-a tasks held the service at 100% CPU with
   * reads timing out (2026-11-05). These two facts only order fair-share requests,
   * so a pass reads each once. A later pass sees any change, and launch still reads
   * its own prerequisites and capacity live.
   */
  async withDispatchPass<T>(pass: () => Promise<T>): Promise<T> {
    if (this.dispatchPassDepth++ === 0) {
      const dependencies = new Map<string, string>();
      const integrationReady = new Map<string, boolean>();
      this.dispatchPassFacts = {
        integrationReady: task => {
          if (!integrationReady.has(task.id)) integrationReady.set(task.id, this.resolution.holdsIntegrationTurn(task));
          return integrationReady.get(task.id)!;
        },
        dependencyWait: task => {
          if (!dependencies.has(task.id)) dependencies.set(task.id, this.store.dependencyWait(task));
          return dependencies.get(task.id)!;
        },
      };
    }
    try { return await pass(); }
    finally { if (--this.dispatchPassDepth === 0) this.dispatchPassFacts = null; }
  }
  /** The prerequisite wait one dispatch pass has read, or a live read outside a pass. */
  passDependencyWait(task: Task): string {
    return (this.dispatchPassFacts ?? this.store).dependencyWait(task);
  }
  /** Read-only board batch; never retained across a revision or used by launch. */
  slotAdmissionReader(tasks: Task[], runs: Run[], includeRecovery = false): (task: Task) => string {
    const dependencies = new Map<string, string>();
    const integrationReady = new Map<string, boolean>();
    const runsByTask = new Map<string, Run[]>();
    for (const run of runs) {
      const queue = runsByTask.get(run.taskId);
      if (queue) queue.push(run);
      else runsByTask.set(run.taskId, [run]);
    }
    const view: SlotAdmissionView = {
      tasks, runsByTask, requestFlags: new Map(),
      globalLimit: this.store.getMeta<number>('globalLimit') ?? DEFAULT_GLOBAL_LIMIT,
      projectLimitFor: this.store.projectDispatchLimitResolver(), papercuts: this.store.papercutDispatchPolicy(),
      integrationReady: task => {
        if (!integrationReady.has(task.id)) integrationReady.set(task.id, this.resolution.holdsIntegrationTurn(task));
        return integrationReady.get(task.id)!;
      },
      dependencyWait: task => {
        if (!dependencies.has(task.id)) dependencies.set(task.id, this.store.dependencyWait(task));
        return dependencies.get(task.id)!;
      },
    };
    return task => this.resolution.slotAdmissionReason(task, includeRecovery, undefined, view);
  }
  /**
   * `parkedPhases`: parked phases that count as slot requests. Fair-share ranks
   * in-flight requests ahead of never-dispatched queued ones. Queued dispatch,
   * review and revision share this set so a free slot goes to in-flight work first.
   */
  // Verification is mechanical: hosted checks and merge gates reserve no agent slot.
  slotAdmissionReason(task: Task, includeRecovery = false, parkedPhases: readonly string[] = ['awaiting_review', 'changes_requested'], view?: SlotAdmissionView): string {
    // A completed retained wait on changes_requested is parked for explicit
    // operator action, so it is not currently requesting a revision slot.
    if (slotAdmissionExempt(task)) return '';
    const tasks = view?.tasks ?? this.store.admissionCandidates(task);
    const current = tasks.find(candidate => candidate.id === task.id) ?? task;
    const taskRuns = view?.runsByTask.get(task.id) ?? this.store.runs(task.id);
    if (slotAdmissionExempt(task, current, taskRuns)) return '';
    const globalLimit = view?.globalLimit ?? this.store.getMeta<number>('globalLimit') ?? DEFAULT_GLOBAL_LIMIT;
    const projectLimitFor = view?.projectLimitFor ?? this.store.projectDispatchLimitResolver();
    const papercuts = view?.papercuts ?? this.store.papercutDispatchPolicy();
    const facts = view ?? this.dispatchPassFacts;
    const isRequest = (candidate: Task) => {
      const known = view?.requestFlags?.get(candidate.id);
      if (known !== undefined) return known;
      const requesting = readsAsRequest(candidate);
      view?.requestFlags?.set(candidate.id, requesting);
      return requesting;
    };
    const readsAsRequest = (candidate: Task) => {
      const input: { integrationReady?: boolean; routingRetryAllowed?: boolean; dependencyWait?: string } = {};
      let result = slotRequestDecision(candidate, parkedPhases, includeRecovery, input);
      if (result === 'read' && candidate.phase === 'verifying' && !candidate.resolution.mergedCommit && candidate.resolution.integrationTurn) {
        input.integrationReady = facts ? facts.integrationReady(candidate) : this.resolution.holdsIntegrationTurn(candidate);
        result = slotRequestDecision(candidate, parkedPhases, includeRecovery, input);
      }
      if (result === 'read' && routeUnavailableStop(candidate)) {
        input.routingRetryAllowed = this.store.routingRetryAllowed(candidate);
        result = slotRequestDecision(candidate, parkedPhases, includeRecovery, input);
      }
      if (result === 'read' && candidate.phase === 'queued') {
        input.dependencyWait = (facts ?? this.store).dependencyWait(candidate);
        result = slotRequestDecision(candidate, parkedPhases, includeRecovery, input);
      }
      return result === true;
    };
    const capacity = capacityFor(task, tasks, globalLimit, projectLimitFor(task), papercuts);
    let requests: Task[] = [], waiters: Task[] = [];
    if (capacity) {
      const key = slotPoolKey(task, papercuts);
      waiters = tasks.filter(candidate => candidate.id !== task.id &&
        (capacity.startsWith("Global") || slotPoolKey(candidate, papercuts) === key) &&
        isInFlightSlotRequest(candidate) && isRequest(candidate));
    } else {
      requests = view?.requests ?? fairSlotRequestOrder(tasks, isRequest);
      if (view) view.requests = requests;
    }
    return decideSlotAdmission(task, tasks, globalLimit, projectLimitFor, papercuts, capacity, requests, waiters);
  }

  projectInFlightAdmissionReason(task: Task): string {
    return projectInFlightWaitReason(task, this.store.activeCapacityTasks(), this.store.projectKeyResolver(),
      candidate => this.store.projectInFlightLimitFor(candidate));
  }
}
