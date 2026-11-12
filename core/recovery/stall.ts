import type { TimelineEntry, TimelineCursor, TimelinePage } from '../host/types';
export type { TimelineEntry, TimelineCursor, TimelinePage } from '../host/types';
import { isDeepStrictEqual } from 'node:util';
import { isDispositionActive, isDispositionComplete, DEFAULT_STALL_THRESHOLD_MINUTES } from '../../shared/contracts';
import { workerRouteProfile } from '../../shared/pool';
import type { Run, StalledTurnStop, Task } from '../../shared/contracts';
import type { AgentObservation } from '../host/adapter';
import type { Resolution } from '../resolution';
import { dispatchBlocked } from '../dispatch/capacity';
import { now } from '../store/store';
import { OPERATOR_WORKER_REMAP_REASON } from './task-reasons';
import { decideWorkerReplacement, isWorkerRouteApproved } from './worker-replacement';
import { resolve, sep } from 'node:path';

/**
 * Mid-turn stall detection (Queue reliability lane). Paseo keeps reporting a
 * frozen agent as running, so a stalled worker or reviewer reads as healthy
 * work. The agent record carries `updatedAt`, which advances with timeline
 * activity; a running agent whose activity has been quiet past the threshold
 * is stalled. The incident is retained with its task/run identity; Queue never
 * interrupts or replaces a live agent automatically.
 */

/** How long one shell command may run before the task shows a notice. */
export const SHELL_NOTICE_MS = 15 * 60_000;

/** The oldest still-running shell command on one timeline page, or null. Unreadable pages are never evidence. */
export function runningShellCommand(entries: TimelineEntry[] | null): { startedAt: string; command: string } | null {
  if (!entries) return null;
  let found: { startedAt: string; command: string } | null = null;
  for (const entry of entries) {
    if (entry?.item?.type !== 'tool_call' || entry.item.status !== 'running' || entry.item.detail?.type !== 'shell') continue;
    const command = String(entry.item.detail.command ?? '').trim().slice(0, 120);
    if (!command) continue;
    const startedAt = String(entry.timestamp ?? '');
    if (!Number.isFinite(Date.parse(startedAt))) continue;
    if (!found || Date.parse(startedAt) < Date.parse(found.startedAt)) found = { startedAt, command };
  }
  return found;
}

/** Reconcile one stalled-turn stop against a fresh observation. */
export type StalledStopDecision =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'completion' }
  | { kind: 'restart' }
  | { kind: 'identity_mismatch' | 'agent_changed' | 'busy_permission' | 'busy_other_turn' | 'busy_same_turn' | 'busy_unknown_turn' | 'incomplete' | 'inactive'; reason: string };

export function stalledStopDecision(facts: {
  stop: StalledTurnStop | null | undefined;
  run: Run | null;
  targetRun: Run | null;
  current: Task;
  paused: boolean;
  dispatchBlocked: boolean;
  state: Pick<AgentObservation, 'id' | 'workspaceId' | 'active' | 'permissions' | 'status' | 'activeTurnId'>;
  authenticCompletion: boolean;
}): StalledStopDecision {
  const stop = facts.stop;
  if (!stop || stop.status === 'completed') return { kind: 'none' };
  const identityMatches = stop.role === 'worker'
    ? !facts.run && facts.current.runId === stop.runId && facts.current.agentId === stop.agentId && facts.current.workspaceId === stop.workspaceId
    : Boolean(facts.run && facts.targetRun && facts.targetRun.id === stop.runId && facts.targetRun.role === stop.role && facts.targetRun.agentId === stop.agentId && facts.targetRun.workspaceId === stop.workspaceId
      && facts.current.resolution.currentRunId === stop.runId && (stop.role !== 'reviewer' || facts.current.resolution.reviewerAgentId === stop.agentId)
      && (!facts.current.prHead || facts.targetRun.head === facts.current.prHead));
  if (!identityMatches)
    return { kind: 'identity_mismatch', reason: `Stalled-turn stop for ${stop.role} run ${stop.runId} no longer matches the task's assigned run identity; the lease remains held for owner inspection` };
  if (facts.paused || facts.dispatchBlocked) return { kind: 'held' };
  if (facts.state.id !== stop.agentId || facts.state.workspaceId !== stop.workspaceId)
    return { kind: 'agent_changed', reason: `Stalled-turn stop for ${stop.role} run ${stop.runId} cannot be reconciled: the retained agent or workspace identity changed; the lease remains held` };
  const busy = facts.state.active || facts.state.permissions || ['running', 'initializing'].includes(facts.state.status);
  if (busy) {
    const kind = facts.state.permissions ? 'busy_permission' as const
      : facts.state.activeTurnId && facts.state.activeTurnId !== stop.turnId ? 'busy_other_turn' as const
        : facts.state.activeTurnId === stop.turnId ? 'busy_same_turn' as const
          : 'busy_unknown_turn' as const;
    const reason = facts.state.permissions
      ? `Stalled-turn stop for ${stop.role} run ${stop.runId} is waiting on an active Paseo permission request; the run lease remains held`
      : facts.state.activeTurnId && facts.state.activeTurnId !== stop.turnId
        ? `The authorized stalled ${stop.role} turn ${stop.turnId} ended or changed, but agent ${stop.agentId} is active on turn ${facts.state.activeTurnId}; no other turn was interrupted and the run lease remains held`
        : facts.state.activeTurnId === stop.turnId
          ? `Stop request for stalled ${stop.role} run ${stop.runId} turn ${stop.turnId} is ${stop.status}; waiting for observed inactivity and retaining the run lease`
          : `Paseo does not expose the current turn for stalled ${stop.role} run ${stop.runId}; retaining its lease until inactivity can be proved`;
    return { kind, reason };
  }
  if (!['idle', 'error', 'closed'].includes(facts.state.status))
    return { kind: 'incomplete', reason: `Stalled-turn stop for ${stop.role} run ${stop.runId} has no complete inactivity observation (${facts.state.status}); the run lease remains held` };
  if (facts.authenticCompletion) return { kind: 'completion' };
  if (stop.restartInstruction) return { kind: 'restart' };
  return { kind: 'inactive', reason: `The operator-authorized stalled ${stop.role} run ${stop.runId} turn ${stop.turnId} is inactive. No authenticated result or review verdict was received, and no replacement turn was started. The owner must choose the next action.` };
}

export type StallsContext = Pick<Resolution, 'adapter' | 'attention' | 'host' | 'onTaskHost' | 'paused' | 'profiles' | 'recordStop' | 'recovery' | 'saveIncident' | 'store' | 'update' | 'waiting'>;

export class Stalls {
  /** Per-agent coalescing for timeline peeks; the cached verdict holds for the window so repeated observations agree. */
  private shellPeeks = new Map<string, { at: number; notice: string | null }>();
  /** How long one peek's verdict is reused; tests shorten it to drive successive peeks. */
  peekTtlMs = 60_000;
  constructor(private readonly resolution: StallsContext) {}
  private get store() { return this.resolution.store; }
  private thresholdMs() { return (this.store.getMeta<number>('stallThresholdMinutes') ?? DEFAULT_STALL_THRESHOLD_MINUTES) * 60_000; }

  /**
   * One observation of a Queue run mid-turn. Detects a stalled turn and a
   * long-running shell command, and returns the shell-command notice text for
   * the task, or null; the caller shows it. A stale turn enters normal
   * attention and coordinator recovery. A run that already reported, or has no
   * activity timestamp, is never flagged. A permission pending past the stall
   * threshold is a stall: it raises owner attention and names the request.
   * Nothing is auto-approved or auto-denied.
   */
  async check(t: Task, run: Run | null, state: AgentObservation): Promise<string | null> {
    const current = this.store.task(t.id);
    if (isDispositionActive(current) || isDispositionComplete(current)) return null;
    // Brief scope: initial workers, revisions and reviewers. Verification and
    // closeout coordinators keep their existing callback-reminder recovery.
    if (run && run.role !== 'revision' && run.role !== 'reviewer') return null;
    if (run?.completion || run === null && current.completion) return null;
    if (!state.active && !state.permissions) return null;
    const role = run?.role === 'reviewer' ? 'Reviewer' : 'Worker';
    const runId = run?.id ?? current.runId;
    if (!runId) return null;
    const shellNotice = await this.shellNotice(current, role, state);
    // No activity timestamp is no evidence of staleness; never judge without it.
    if (!state.updatedAt || !Number.isFinite(Date.parse(state.updatedAt))) return shellNotice;
    const quietMs = Date.now() - Date.parse(state.updatedAt);
    if (quietMs < this.thresholdMs()) return shellNotice;
    const turn = state.activeTurnId ? `, active turn ${state.activeTurnId}` : '';
    const pending = state.pendingRequest;
    const stalled = state.permissions
      ? pending
        ? `pending ${pending.kind === 'question' ? 'question' : 'permission'} ${pending.id}${pending.firstLine ? `: ${pending.firstLine}` : ''}`
        : 'a pending permission with no agent activity'
      : 'no agent activity while Paseo still reports it running';
    const reason = `The ${role.toLowerCase()} run ${runId} (agent ${state.id}${turn}) looks stalled: ${stalled}. It still owns this task; the owner may use restart for this exact run after checking its retained identity`;
    this.resolution.attention(this.store.task(current.id), reason, 'stalled_turn');
    this.resolution.recordStop(this.store.task(current.id), 'run_stalled', reason, ['restart']);
    if (state.activeTurnId && !this.store.task(current.id).resolution.incident?.turnId)
      this.resolution.saveIncident(this.store.task(current.id), { turnId: state.activeTurnId });
    return shellNotice;
  }

  /**
   * Show or clear the shell-command notice on a task. The shown notice and the
   * reason it replaced live in the durable event ledger, not in process state,
   * so a service restart can still clear a persisted notice whose command has
   * ended. Clearing restores the replaced reason only while it is still
   * showing: a fault that wrote a different reason in between is never
   * clobbered. The ledger write and the reason write commit in one
   * transaction, so a crash can never leave a shown marker over a reason that
   * was never updated. The engine's worker path composes its own reason every
   * pass and does not use this; only the run observer's writes need a clear
   * owner.
   */
  settleNotice(t: Task, notice: string | null): void {
    const shown = this.shownNotice(t.id);
    this.store.transaction(() => {
      const current = this.store.task(t.id);
      if (notice) {
        if (shown?.notice === notice) return;
        const previous = shown && current.reason === shown.notice ? shown.previous : current.reason;
        this.store.event(current.id, 'shell_notice_shown', JSON.stringify({ runId: current.resolution.currentRunId ?? current.runId, notice, previous }));
        if (current.reason !== notice) this.resolution.waiting(current, notice, 'lifecycle');
        return;
      }
      if (!shown) return;
      if (current.reason === shown.notice) this.resolution.waiting(current, shown.previous, 'classify');
      this.store.event(current.id, 'shell_notice_cleared', shown.notice);
    });
  }

  /** The live shown notice from the ledger, or null once cleared; a corrupt row is no notice. */
  private shownNotice(taskId: string): { runId: string | null; notice: string; previous: string } | null {
    for (const event of this.store.events(taskId)) {
      try { if (event.kind === 'shell_notice_shown') return JSON.parse(event.detail); } catch { return null; }
      if (event.kind === 'shell_notice_cleared') return null;
    }
    return null;
  }

  /**
   * A run whose current shell command has been running past the notice
   * threshold shows on the task instead of reading as healthy or stalled. The
   * timeline peek is coalesced per agent and a failed read is no notice.
   */
  private async shellNotice(t: Task, role: string, state: AgentObservation): Promise<string | null> {
    const turnStartedAt = state.turnStartedAt ? Date.parse(state.turnStartedAt) : NaN;
    // A command cannot outlive its turn, so a young turn never needs a peek.
    if (!Number.isFinite(turnStartedAt) || Date.now() - turnStartedAt < SHELL_NOTICE_MS) return null;
    const agentId = state.id;
    const lastPeek = this.shellPeeks.get(agentId);
    if (lastPeek && Date.now() - lastPeek.at < this.peekTtlMs) return lastPeek.notice;
    let notice: string | null = null;
    try {
      const timeline = this.resolution.adapter.agentTimeline ? await this.resolution.onTaskHost(t, () => this.resolution.host.agentTimeline(agentId)) : undefined;
      notice = this.shellNoticeText(role, runningShellCommand(timeline ?? null));
    }
    catch { notice = null; }
    if (this.shellPeeks.size > 512) this.shellPeeks.clear();
    this.shellPeeks.set(agentId, { at: Date.now(), notice });
    return notice;
  }

  /** The notice text for one peek result, or null; the durable shown event is written by settleNotice. */
  private shellNoticeText(role: string, running: { startedAt: string; command: string } | null): string | null {
    if (!running || Date.now() - Date.parse(running.startedAt) < SHELL_NOTICE_MS) return null;
    return `${role} is executing a shell command that has run for over ${Math.floor(SHELL_NOTICE_MS / 60000)} minutes (started at ${running.startedAt}): ${running.command}`;
  }
  /**
   * Reconcile one operator-authorized stalled-turn stop against a fresh live
   * observation. The stop intent never launches a replacement: the run stays
   * leased until this method sees inactivity or an authenticated completion.
   * Passing null is the initial worker, whose run identity lives on the task.
   */
  reconcileStalledTurnStop(task:Task,run:Run|null,state:AgentObservation):boolean{
    const stop=task.resolution.stalledTurnStop;
    if(!stop||stop.status==='completed')return false;
    const current=this.store.task(task.id);
    const targetRun=run?this.store.run(run.id):null;
    const authenticCompletion=stop.role==='worker'
      ? current.completion?.runId===stop.runId
      : Boolean(targetRun?.completion?.runId===stop.runId);
    const decision=stalledStopDecision({stop,run,targetRun,current,paused:this.resolution.paused(),dispatchBlocked:dispatchBlocked(current),state,authenticCompletion});
    switch(decision.kind){
      case 'none': return false;
      case 'identity_mismatch':
        if(current.reason!==decision.reason)this.resolution.attention(current,decision.reason);
        return true;
      case 'held': return true;
      case 'agent_changed':
        this.resolution.attention(current,decision.reason);
        return true;
      case 'busy_permission':
      case 'busy_other_turn':
      case 'busy_same_turn':
      case 'busy_unknown_turn':
        if(current.reason!==decision.reason)this.store.update(current.id,{reason:decision.reason},'stalled_turn_stop_waiting',decision.reason);
        return true;
      case 'incomplete':
        this.resolution.attention(current,decision.reason);
        return true;
      default: break;
    }
    const at=now();
    if(decision.kind==='completion'){
      this.store.transaction(()=>{
        const latest=this.store.task(task.id),latestStop=latest.resolution.stalledTurnStop;
        if(!latestStop||latestStop.runId!==stop.runId||latestStop.status==='stopped')return;
        if(run){
          const latestRun=this.store.run(run.id);
          if(latestRun?.completion?.runId===run.id&&!latestRun.released)this.store.putRun({...latestRun,active:false,lastObservedAt:at,idleSince:latestRun.idleSince??at,status:'finished',released:true});
        }
        this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:{...latestStop,status:'completed',observedInactiveAt:at,
          detail:'Authentic authenticated completion was retained; no replacement delivery was created'}},
          reason:'Authenticated completion retained after the stopped turn became inactive'},'stalled_turn_completion_preserved',stop.runId);
      });
      return true;
    }
    // Spec 050 `restart`: a continuation recorded with the stop is applied here
    // once inactivity is observed. The run is released and the instruction goes
    // to the next run instead of parking the task for an owner decision.
    if(decision.kind==='restart'){
      const instruction=stop.restartInstruction!;
      this.store.transaction(()=>{
        const latest=this.store.task(task.id),latestStop=latest.resolution.stalledTurnStop;
        if(!latestStop||latestStop.runId!==stop.runId||['completed','stopped'].includes(latestStop.status))return;
        if(run){
          const latestRun=this.store.run(run.id);
          if(!latestRun||latestRun.released||latestRun.agentId!==stop.agentId||latestRun.workspaceId!==stop.workspaceId
            ||latest.resolution.currentRunId!==stop.runId||latestRun.completion)return;
          this.store.putRun({...latestRun,active:false,lastObservedAt:at,idleSince:latestRun.idleSince??at,status:'superseded',released:true});
        }else if(latest.runId!==stop.runId||latest.agentId!==stop.agentId||latest.completion)return;
        // The stop is `completed`, not `stopped`: the continuation is recorded
        // and the lane must proceed to launch it. Every `stalledTurnStop` gate
        // treats `completed` as reconciled, while `stopped` keeps the task
        // parked behind the stop (taskQuantum) and refuses the next verb.
        const released=this.store.update(latest.id,{resolution:{...latest.resolution,stalledTurnStop:{...latestStop,status:'completed' as const,observedInactiveAt:at,
          detail:'The restart continuation released the stopped run'}}},'stalled_turn_restart_released',stop.runId);
        if(stop.role==='reviewer'){
          this.resolution.update(released,{currentRunId:null,reviewerAgentId:latestStop.restartFresh?null:run!.agentId,reviewerProfile:latestStop.restartFresh?null:run!.profile,review:null,attention:false,recoveryActive:false,recovery:null,incident:null,pendingReviewReason:instruction},
            {phase:'awaiting_review',reason:`Restart continuation after stopped reviewer run ${stop.runId}`},'stalled_turn_restart_continuation',instruction);
        }else{
          // Spec 058 task 577: one worker thread. A stalled turn is an unfinished
          // continuation, not a failure: a fresh restart after it replaces only
          // for a failure or an approved route to a different model. Otherwise
          // the refusal names its rule and the retained worker continues.
          let stalledReplacement: { failoverReason: string; replacementProfile: { profileId: string; reason: string } } | null = null;
          if (latestStop.restartFresh) {
            const stalledRoute = workerRouteProfile(latest) ?? latest.profile!.id;
            const stalledDecision = decideWorkerReplacement({
              task: latest,
              requestedProfileId: stalledRoute,
              requestedModel: this.resolution.profiles().find(candidate => candidate.id === stalledRoute)?.model ?? latest.profile?.model ?? null,
              currentModel: latest.profile?.model ?? null,
              approved: isWorkerRouteApproved(latest, stalledRoute, this.store.pool(), this.store.usageLevel()),
              failure: latest.completion?.providerUnavailable
                ? { kind: "provider_failure" as const, detail: "the retained worker reported provider exhaustion" } : null,
              explicitOperatorRelay: false,
              freshRestart: true,
            });
            if (stalledDecision.allowed) {
              stalledReplacement = { failoverReason: `${OPERATOR_WORKER_REMAP_REASON}. Continue the existing task: ${instruction}`.slice(0, 2000),
                replacementProfile: { profileId: stalledRoute, reason: 'Fresh restart after a stalled turn' } };
            } else {
              this.store.event(latest.id, "worker_replacement_refused", `${stalledDecision.rule}: ${stalledDecision.detail}`);
            }
          }
          this.resolution.update(released,{currentRunId:null,attention:false,recoveryActive:false,recovery:null,incident:null,
            prePrResumeInstruction:instruction,pendingWorkerInstruction:instruction},
            {phase:'changes_requested',reason:`Restart continuation after stopped ${stop.role} run ${stop.runId}`,
              ...(stalledReplacement ?? {})},'stalled_turn_restart_continuation',instruction);
        }
      });
      return true;
    }
    const reason=decision.kind==='inactive'?decision.reason:`The operator-authorized stalled ${stop.role} run ${stop.runId} turn ${stop.turnId} is inactive. No authenticated result or review verdict was received, and no replacement turn was started. The owner must choose the next action.`;
    const reconciled=this.store.transaction(()=>{
      const latest=this.store.task(task.id),latestStop=latest.resolution.stalledTurnStop;
      if(!latestStop||latestStop.runId!==stop.runId||latestStop.status==='completed'||latestStop.status==='stopped')return latest;
      if(run){
        const latestRun=this.store.run(run.id);
        if(!latestRun||latestRun.released||latestRun.agentId!==stop.agentId||latestRun.workspaceId!==stop.workspaceId
          ||latest.resolution.currentRunId!==stop.runId||latestRun.completion)return latest;
        this.store.putRun({...latestRun,active:false,lastObservedAt:at,idleSince:latestRun.idleSince??at,status:'superseded',released:true});
      }else if(latest.runId!==stop.runId||latest.agentId!==stop.agentId||latest.completion)return latest;
      const updated=this.resolution.update(latest,{attention:true,stalledTurnStop:{...latestStop,status:'stopped',observedInactiveAt:at,
        detail:'Paseo reported the assigned agent inactive; the run lease was released without accepting a result'}},
        {phase:'needs_attention',reason},'stalled_turn_reconciled',`${stop.runId}/${stop.turnId}`);
      this.resolution.recovery.escalate(updated,reason);
      return this.store.task(updated.id);
    });
    return reconciled.resolution.stalledTurnStop?.runId===stop.runId;
  }
}

/** A tool in a terminal state owns no live effect, whatever its renderer type. */
export const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'canceled', 'cancelled']);
/**
 * Tool kinds whose effect cannot outlive the provider turn that started it:
 * once no turn is live, a call of one of these kinds owns no live effect even
 * if the provider never wrote a terminal status for its entry. Everything else
 * keeps the fence — a shell command or a worktree setup runs as a process the
 * turn detaches (the background shells and terminals that genuinely outlive a
 * turn), and a missing or unrecognised kind is unknown, never settled.
 */
/**
 * Queue's own MCP tools, which can't outlive the turn that called them. The
 * `northstar_*` and `northstar_queue.*` names stay readable here, and only here,
 * because a stored timeline from a pre-Nucleus session still names them.
 */
export const QUEUE_OWN_TOOL = /^(?:(?:mcp__)?(?:northstar_queue|nucleus)[._]|(?:northstar|nucleus)_(?:report|ask|message|tell)$)/;
export const TURN_BOUND_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'search', 'fetch', 'sub_agent', 'plain_text', 'plan']);
export function turnBoundTool(entry: TimelineEntry): boolean {
  const kind = String(entry.item.detail?.type ?? '');
  return TURN_BOUND_TOOL_KINDS.has(kind) || ((!kind || kind === 'unknown') && QUEUE_OWN_TOOL.test(String(entry.item.name ?? '')));
}
export const TOOL_TIMELINE_LIMIT = 200;
/** At most six tail requests, growing from the larger of the request and returned count. */
export const TOOL_TIMELINE_READ_BUDGET = 6;
export const TOOL_TIMELINE_READ_TIMEOUT_MS = 10_000;

function validCursor(cursor: TimelineCursor | null | undefined, epoch: string): cursor is TimelineCursor {
  return Boolean(cursor && cursor.epoch === epoch && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0);
}

/**
 * The observed turn facts one owned-tool proof reads to settle a turn-bound
 * call. Each is optional in type only because an observation can omit it: an
 * omitted fact is unknown, and `noTurnLive` never reads it as a negative.
 */
export type ObservedTurnState = Partial<Pick<AgentObservation, 'status' | 'active' | 'activeTurnId' | 'permissions'>>;

/**
 * Whether one observation proves that no provider turn is live. Every fact is
 * read positively: the agent is inactive, reported `activeTurnId: null` (both
 * Paseo adapters always set it, so an absent field is unknown, not idle),
 * awaits no permission and reports a status of a finished session. A
 * contradiction between those facts, an observation missing any of them and
 * an unobservable agent all read as a live turn, never as a completed one.
 */
export function noTurnLive(state: ObservedTurnState | null | undefined): boolean {
  return Boolean(state && state.active === false && state.activeTurnId === null && state.permissions === false
    && ['idle', 'error', 'closed'].includes(state.status ?? ''));
}

/** Live process facts that keep a finished-turn shell tool from being settled. */
export function workspaceToolProcessIssue(processes: Array<{ pid: number; ppid?: number | null; command: string; cwd: string | null }>, directory: string, runIds: readonly string[]): string | null {
  if (!runIds.length) return 'the participant has no recorded run identity for process proof';
  for (const process of processes) {
    if (runIds.some(runId => process.command.includes('mcp-report.mjs') && process.command.includes(`mcp-${runId}.json`)))
      return `provider process ${process.pid} still carries the run MCP ticket`;
    if (process.command.includes('mcp-report.mjs') && process.command.includes('/tickets/mcp-'))
      return `provider process ${process.pid} carries an unreadable or truncated MCP ticket identity`;
  }
  const root = resolve(directory);
  const rooted = new Set<number>();
  for (const process of processes) {
    if (!process.command.trim()) return `process ${process.pid} has an unreadable command identity`;
    if (process.cwd === null) return `process ${process.pid} has an unreadable working directory`;
    const cwd = resolve(process.cwd);
    if (cwd === root || cwd.startsWith(`${root}${sep}`)) rooted.add(process.pid);
    else if (process.ppid == null) return `process ${process.pid} has an unreadable parent identity`;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (!rooted.has(process.pid) && process.ppid != null && rooted.has(process.ppid)) {
      rooted.add(process.pid); changed = true;
    }
  }
  const process = processes.find(item => rooted.has(item.pid));
  return process ? `process ${process.pid} remains in the task workspace process tree` : null;
}

/**
 * The turn facts of one fresh observation, read after the tool evidence it
 * settles: an unreadable observation, or one about a different agent, is
 * unknown (null) and settles nothing.
 */
export async function observedTurnState(host: { observe(id: string): Promise<AgentObservation> }, agentId: string): Promise<ObservedTurnState | null> {
  try {
    const state = await host.observe(agentId);
    return state && state.id === agentId ? state : null;
  } catch { return null; }
}

/**
 * Widen tails instead of splicing projected pages: projection can collapse tool
 * lifecycle entries across a cursor seam. Every accepted proof is one provider
 * response, with every previously observed entry retained unchanged as a suffix.
 * No turn IDs is normal; then only the whole history supplies positive coverage.
 */
export async function readToolTimeline(host: { agentTimelinePage?(id: string, limit?: number): Promise<TimelinePage | null> },
  agentId: string): Promise<{ entries: TimelineEntry[] } | { issue: string }> {
  if (!host.agentTimelinePage) return { issue: 'tool observations have no completeness evidence' };
  let previous: TimelinePage | undefined;
  let limit = TOOL_TIMELINE_LIMIT;
  for (let read = 0; read < TOOL_TIMELINE_READ_BUDGET; read++) {
    // A projected anchor can extend past the next nominal doubled window.
    // Request beyond that entire suffix so genuine progress remains possible.
    if (previous) limit = Math.max(limit, previous.entries.length) * 2;
    let page: TimelinePage | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      page = await Promise.race([
        host.agentTimelinePage(agentId, limit),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('read timed out')), TOOL_TIMELINE_READ_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      return { issue: `tool observations read ${read + 1} failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally { clearTimeout(timer); }
    if (!page) return { issue: `tool observations read ${read + 1} is unavailable` };
    if (page.gap === true) return { issue: 'tool observations report a gap, so a live tool in the missing segment cannot be ruled out' };
    if (page.staleCursor === true || page.reset === true) return { issue: 'tool observations report a stale cursor or history reset' };
    if (page.hasNewer === true) return { issue: 'tool observations omit newer history' };
    if (page.gap !== false || page.staleCursor !== false || page.reset !== false || page.hasNewer !== false
      || typeof page.hasOlder !== 'boolean' || !page.epoch || !['projected', 'canonical'].includes(page.projection ?? ''))
      return { issue: 'tool observations are missing positive coverage metadata' };
    // Paseo extends projected tails to include earlier anchors whose tool
    // updates overlap the window. The requested limit is not a response cap.
    if (!Array.isArray(page.entries)) return { issue: 'tool observations have missing entries' };
    if (!page.entries.length) {
      if (previous || page.hasOlder || page.startCursor !== null || page.endCursor !== null)
        return { issue: 'empty tool observations have inconsistent cursor coverage' };
      return { entries: [] };
    }
    if (!validCursor(page.startCursor, page.epoch) || !validCursor(page.endCursor, page.epoch)
      || page.startCursor.seq > page.endCursor.seq)
      return { issue: 'tool observations have missing or inconsistent cursors' };
    if (previous) {
      if (page.epoch !== previous.epoch || page.projection !== previous.projection
        || !isDeepStrictEqual(page.endCursor, previous.endCursor))
        return { issue: 'tool observations changed epoch, projection or newest cursor during retrieval' };
      if (page.startCursor.seq >= previous.startCursor!.seq || page.entries.length <= previous.entries.length)
        return { issue: 'tool observations made no backwards cursor progress' };
      if (!isDeepStrictEqual(page.entries.slice(-previous.entries.length), previous.entries))
        return { issue: 'tool observations changed or lost the previously read segment' };
    }
    // Turn coverage needs real IDs and unambiguous chronological ordering;
    // incomplete/mixed IDs never invent a boundary for projected histories.
    const ordered = [...page.entries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const oldest = ordered[0], newest = ordered.at(-1)!;
    const turnCovered = ordered.every(entry => entry.turnId && Number.isFinite(Date.parse(entry.timestamp)))
      && oldest.turnId !== newest.turnId && Date.parse(oldest.timestamp) < Date.parse(newest.timestamp);
    if (!page.hasOlder || turnCovered) return { entries: page.entries };
    previous = structuredClone(page);
  }
  return { issue: `tool observations remain partial after ${TOOL_TIMELINE_READ_BUDGET} reads (largest requested limit ${limit}); latest turn coverage is unproven` };
}
/**
 * Why recent tool history fails to prove that no live tool remains, or null.
 * A tool call appears once per state change (running, then completed), so
 * each call is judged by its latest state in time, matched by call ID. A
 * later completed, failed or canceled entry settles an earlier running one;
 * a latest running or status-less entry stays live unless the caller supplies
 * the agent's own observation and that observation proves no turn is live: a
 * call of a `TURN_BOUND_TOOL_KINDS` kind cannot outlive the turn that started
 * it, so a running entry left behind by a finished turn is settled. A shell
 * command, a worktree setup, an unknown kind, an unrecognised status, absent
 * turn proof and ambiguous evidence all still refuse. Evidence that cannot be
 * ordered or matched refuses: a missing call ID or time, unsettled conflicting tool or command identity, or two different states at the same
 * instant.
 */
export function liveToolIssue(entries: TimelineEntry[], owner?: ObservedTurnState | null): string | null {
  const calls = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    if (entry.item.type !== 'tool_call') continue;
    const callId = entry.item.callId ? String(entry.item.callId) : '';
    if (!callId || !Number.isFinite(Date.parse(entry.timestamp))) return 'an observed tool has incomplete identity or time evidence';
    calls.set(callId, [...(calls.get(callId) ?? []), entry]);
  }
  const turnOver = noTurnLive(owner);
  for (const [callId, states] of calls) {
    const names = new Set(states.map(entry => String(entry.item.name ?? '')));
    const commands = new Set(states.map(entry => entry.item.detail?.command).filter(command => command !== undefined).map(String));

    const latestAt = Math.max(...states.map(entry => Date.parse(entry.timestamp)));
    const latest = states.filter(entry => Date.parse(entry.timestamp) === latestAt);
    const statuses = new Set(latest.map(entry => String(entry.item.status ?? '')));
    if (statuses.size > 1) return `observed tool call ${callId} has ambiguous states at one instant`;
    const status = [...statuses][0];
    const conflicting = names.size > 1 || commands.size > 1;
    const allTurnBound = states.every(turnBoundTool);
    if (conflicting && !(turnOver && (TERMINAL_TOOL_STATUSES.has(status) || (status === 'running' && allTurnBound))))
      return `observed tool call ${callId} has conflicting tool or command identity${status === 'running' ? ' and is running' : ''}`;
    if (!TERMINAL_TOOL_STATUSES.has(status)) {
      const kind = String(latest[0].item.detail?.type ?? '');
      // Queue's own MCP tools (nucleus_report, ask, tell) answer inside the agent's turn;
      // a running entry left behind by a finished turn is settled like other turn-bound kinds.
      if (turnOver && status === 'running' && turnBoundTool(latest[0])) continue;
      const tool = String(latest[0].item.name ?? 'call');
      const displayKind = kind || 'unknown kind';
      return `observed tool ${tool} (${displayKind}) is ${status || 'without a terminal status'}`;
    }
  }
  return null;
}
