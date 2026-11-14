import { ownedToolAgentProcessTreeVerdict } from './owned-tool-process-proof';
import { readHostUidProcesses } from './host-process-listing';
import type { Resolution } from '../resolution';
import {
  formatLiveToolIssue, liveToolIssueFact, noTurnLive, observedTurnState, readToolTimeline, runningOwnedTool, turnBoundTool,
} from '../recovery/stall';
import type { HostProcessFact } from '../host/types';

/** The owned-tool events this proof reads and writes. */
const OWNED_TOOL_HOLD = 'owned_tool_hold';
const OWNED_TOOL_SETTLED = 'owned_tool_settled';

/**
 * The owned-tool proof: no live tool holds a run.
 *
 * The decision is made on typed facts. The tool timeline reader answers with
 * entries or an issue; `liveToolIssueFact` names the exact fact that refuses
 * (a live non-turn-bound call, a conflicting identity, an unreadable state);
 * the process-tree proof answers empty, live or unknown with its own reason
 * code. The event history is decoded once per run id, not re-parsed per call.
 */
export class OwnedTools {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * The agent's own long-running job, as one readable reason, or null.
   *
   * A stopped thread whose provider timeline still shows its own non-turn-bound
   * tool running is waiting on that job, not a missing callback. This is the
   * reading half of the owned-tool proof: it never settles anything and never
   * reads absent, unreadable or inconclusive evidence as a live job.
   */
  async ownedJobWait(agentId: string): Promise<string | null> {
    if (!this.adapter.agentTimelinePage) return null;
    let read: Awaited<ReturnType<typeof readToolTimeline>>;
    try { read = await readToolTimeline(this.resolution.host, agentId); }
    catch { return null; }
    if ('issue' in read) return null;
    const running = runningOwnedTool(read.entries);
    return running ? `${running.name} (${running.kind}) has been running since ${running.since}` : null;
  }

  /**
   * The existing owned-tool proof, for a delivered turn that is claimed stopped
   * and for every participant of an author capability upgrade: no live tool by
   * timeline evidence. A stop-backed resume and a retirement need *positive*
   * proof, so an adapter with no timeline is unavailable evidence and refuses
   * rather than reading as clear; inconclusive evidence always holds (review
   * 5672703363, finding 2).
   *
   * Liveness, not history: a running entry is settled once the same agent's own
   * fresh observation proves no turn is live and the call's kind cannot outlive
   * its turn. Any other running kind needs the same run-rooted host process
   * proof; if the provider process is absent, a complete no-ticket/no-workspace
   * scan can prove it stale. Worktree setups, unknown kinds and unreadable
   * observations hold without that proof. Once that observation proves no turn
   * is live, the provider's own standing tool runtimes are not descendants for
   * the proof either — they outlive every turn by design — while a command one
   * of them spawned still counts as work.
   */
  async ownedToolHold(agentId: string, options: { requireCompleteEvidence?: boolean; runId?: string; runIds?: string[]; taskId?: string; workspaceId?: string } = {}): Promise<string | null> {
    if (!this.adapter.agentTimelinePage)
      return options.requireCompleteEvidence ? 'owned tool evidence is unavailable: this adapter offers no tool timeline' : null;
    let read: Awaited<ReturnType<typeof readToolTimeline>>;
    try { read = await readToolTimeline(this.resolution.host, agentId); }
    catch { return 'owned tool evidence is unreadable'; }
    if ('issue' in read) return `owned tool evidence is inconclusive: ${read.issue}`;
    const runIds = options.runIds?.length ? options.runIds : options.runId ? [options.runId] : [];
    if (!liveToolIssueFact(read.entries)) {
      if (options.taskId) for (const runId of runIds)
        this.recordOwnedToolSettlement(options.taskId, runId, 'complete tool timeline has no live or unknown calls');
      return null;
    }
    // The turn proof is read AFTER the evidence it settles: an agent that became
    // active, permissioned or turn-bound since then is caught here and holds.
    const turn = await observedTurnState(this.resolution.host, agentId);
    const issue = liveToolIssueFact(read.entries, turn);
    let hold = issue ? formatLiveToolIssue(issue) : null;
    const processEntries = read.entries.filter(entry => entry.item.type === 'tool_call' && !turnBoundTool(entry));
    const processIssue = liveToolIssueFact(processEntries, turn);
    // A call that is still running and is not turn-bound is the only shape the
    // process tree can settle; a turn-bound call never outlives its turn.
    const processOwnsWork = processIssue?.kind === 'live' && processIssue.status === 'running'
      || processIssue?.kind === 'conflicting-identity' && processIssue.running;
    const turnBoundOnly = read.entries.filter(entry => !processEntries.includes(entry));
    if (hold && runIds.length && options.taskId && noTurnLive(turn) && processIssue && processOwnsWork
      && liveToolIssueFact(turnBoundOnly, turn) === null) {
      const toolLabel = formatLiveToolIssue(processIssue);
      let processes: HostProcessFact[] | null = null;
      if (this.adapter.hostProcessListing) {
        try { processes = await this.adapter.hostProcessListing(); } catch { processes = null; }
      } else {
        const listing = await readHostUidProcesses();
        processes = listing.state === 'listed' ? listing.processes : null;
      }
      const verdict = ownedToolAgentProcessTreeVerdict(runIds, processes, { noTurnLive: true });
      if (verdict.state === 'empty') {
        const heldRunId = options.runId ?? verdict.runId;
        this.recordOwnedToolSettlement(options.taskId, heldRunId,
          `run ${heldRunId}: stale non-turn-bound tool settled; agent helper run ${verdict.runId} proves provider pid ${verdict.providerPid} has no live descendants except Nucleus MCP report helper pid ${verdict.helperPid}`, true);
        hold = null;
      } else if (verdict.state === 'live') {
        hold = `${toolLabel}; descendant pid ${verdict.pid} remains under provider pid ${verdict.providerPid}`;
      } else if (verdict.code === 'helper-missing' && options.workspaceId && this.adapter.noLiveWorkspaceProcesses) {
        const workspaceIssue = await this.adapter.noLiveWorkspaceProcesses(options.workspaceId, runIds);
        if (!workspaceIssue) {
          this.recordOwnedToolSettlement(options.taskId, runIds[0]!,
            `run ids ${runIds.join(', ')}: stale non-turn-bound tool settled; no process carried an MCP ticket and the task workspace process tree was empty`, true);
          hold = null;
        } else hold = `${toolLabel}; ${workspaceIssue}`;
      } else hold = `${toolLabel}; process tree is unreadable: ${verdict.reason}`;
    }
    if (hold && options.runId && options.taskId) {
      this.recordOwnedToolHold(options.taskId, options.runId, hold);
      const latestHold = this.latestOwnedToolEvent(options.taskId, options.runId, OWNED_TOOL_HOLD);
      if (this.store.task(options.taskId).resolution.ownerSettlements.some(record =>
        record.effect === `owned_tool.${options.runId}` && record.occurrence === String(latestHold?.id ?? ''))) return null;
    }
    if (!hold && options.taskId) for (const runId of runIds)
      this.recordOwnedToolSettlement(options.taskId, runId, 'fresh tool and owner observations prove the recorded hold settled');
    return hold ? `an owned tool is still live: ${hold}` : null;
  }

  private recordOwnedToolHold(taskId: string, runId: string, reason: string): void {
    const detail = JSON.stringify({ runId, reason });
    const latest = this.latestOwnedToolEvent(taskId, runId, OWNED_TOOL_HOLD, OWNED_TOOL_SETTLED);
    if (latest?.kind === OWNED_TOOL_HOLD && latest.detail === detail) return;
    this.store.event(taskId, OWNED_TOOL_HOLD, detail);
  }

  private recordOwnedToolSettlement(taskId: string, runId: string, evidence: string, force = false): void {
    const latest = this.latestOwnedToolEvent(taskId, runId, OWNED_TOOL_HOLD, OWNED_TOOL_SETTLED);
    if (latest?.kind !== OWNED_TOOL_HOLD && !force) return;
    this.store.event(taskId, OWNED_TOOL_SETTLED, JSON.stringify({ runId, evidence }));
  }

  /**
   * The newest owned-tool event for this run, decoded once. The reader walks the
   * event history from the end and stops at the first owned-tool event, so a
   * long history is not re-parsed on every proof.
   */
  private latestOwnedToolEvent(taskId: string, runId: string, ...kinds: string[]): { kind: string; detail: string; id?: number } | null {
    const events = this.store.eventsAll(taskId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (!kinds.includes(event.kind)) continue;
      const decoded = decodeOwnedToolDetail(event.detail);
      if (!decoded) continue;
      if (decoded.runId === runId) return { kind: event.kind, detail: event.detail, id: event.id };
    }
    return null;
  }
}

/** One owned-tool event detail, decoded once into the run it names. */
export function decodeOwnedToolDetail(detail: string): { runId: string } | null {
  try {
    const decoded = JSON.parse(detail) as { runId?: unknown };
    return typeof decoded.runId === 'string' && decoded.runId ? { runId: decoded.runId } : null;
  } catch { return null; }
}
