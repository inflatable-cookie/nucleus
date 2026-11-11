import { listHostUidProcesses, ownedToolAgentProcessTreeVerdict } from './host-process-reap';
import type { Resolution } from '../resolution';
import { turnBoundTool, liveToolIssue, noTurnLive, observedTurnState, readToolTimeline, type TimelineEntry } from '../recovery/stall';

/** Proves no live tool holds a run, and records the `owned_tool_*` events that say so. */
export class OwnedTools {
  constructor(readonly resolution: Resolution) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

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
    const issue = liveToolIssue(read.entries);
    if (!issue) {
      if (options.taskId) for (const runId of options.runIds?.length ? options.runIds : options.runId ? [options.runId] : [])
        this.recordOwnedToolSettlement(options.taskId, runId, 'complete tool timeline has no live or unknown calls');
      return null;
    }
    // The turn proof is read AFTER the evidence it settles: an agent that became
    // active, permissioned or turn-bound since then is caught here and holds.
    const turn = await observedTurnState(this.resolution.host, agentId);
    let settled = liveToolIssue(read.entries, turn);
    const turnBound = (entry: TimelineEntry) => entry.item.type === 'tool_call'
      && turnBoundTool(entry);
    const processEntries = read.entries.filter(entry => entry.item.type === 'tool_call' && !turnBound(entry));
    const processIssue = liveToolIssue(processEntries, turn);
    const processRunIds=options.runIds?.length ? options.runIds : options.runId ? [options.runId] : [];
    if (settled && processRunIds.length && options.taskId && noTurnLive(turn)
      && processIssue !== null && / is running$/.test(processIssue)
      && liveToolIssue(read.entries.filter(entry => !processEntries.includes(entry)), turn) === null) {
      const toolLabel = processIssue;
      let processes: Awaited<ReturnType<typeof listHostUidProcesses>> = null;
      try { processes = this.adapter.hostProcessListing ? await this.adapter.hostProcessListing() : await listHostUidProcesses(); }
      catch { processes = null; }
      const verdict=ownedToolAgentProcessTreeVerdict(processRunIds,processes,{ noTurnLive: true });
      if (verdict.state==='empty') {
        const heldRunId=options.runId ?? verdict.runId;
        this.recordOwnedToolSettlement(options.taskId, heldRunId,
          `run ${heldRunId}: stale non-turn-bound tool settled; agent helper run ${verdict.runId} proves provider pid ${verdict.providerPid} has no live descendants except Nucleus MCP report helper pid ${verdict.helperPid}`, true);
        settled = null;
      } else if (verdict.state==='live') {
        settled = `${toolLabel}; descendant pid ${verdict.pid} remains under provider pid ${verdict.providerPid}`;
      } else if (verdict.reason==='MCP report helper is missing' && options.workspaceId && this.adapter.noLiveWorkspaceProcesses) {
        const processIssue=await this.adapter.noLiveWorkspaceProcesses(options.workspaceId,processRunIds);
        if (!processIssue) {
          this.recordOwnedToolSettlement(options.taskId, processRunIds[0]!,
            `run ids ${processRunIds.join(', ')}: stale non-turn-bound tool settled; no process carried an MCP ticket and the task workspace process tree was empty`, true);
          settled = null;
        } else settled = `${toolLabel}; ${processIssue}`;
      } else {
        settled = `${toolLabel}; process tree is unreadable: ${verdict.reason}`;
      }
    }
    if (settled && options.runId && options.taskId) {
      this.recordOwnedToolHold(options.taskId, options.runId, settled);
      const latest = this.store.eventsAll(options.taskId).findLast(event => event.kind === 'owned_tool_hold' && (() => {
        try { return JSON.parse(event.detail).runId === options.runId; } catch { return false; }
      })());
      if (this.store.task(options.taskId).resolution.ownerSettlements.some(record =>
        record.effect === `owned_tool.${options.runId}` && record.occurrence === String(latest?.id ?? ''))) return null;
    }
    if (!settled && options.taskId) for (const runId of processRunIds)
      this.recordOwnedToolSettlement(options.taskId, runId, 'fresh tool and owner observations prove the recorded hold settled');
    return settled ? `an owned tool is still live: ${settled}` : null;
  }

  private recordOwnedToolHold(taskId: string, runId: string, reason: string): void {
    const detail = JSON.stringify({ runId, reason });
    const latest = this.store.eventsAll(taskId).reverse().find(event => ['owned_tool_hold', 'owned_tool_settled'].includes(event.kind)
      && (() => { try { return JSON.parse(event.detail).runId === runId; } catch { return false; } })());
    if (latest?.kind === 'owned_tool_hold' && latest.detail === detail) return;
    this.store.event(taskId, 'owned_tool_hold', detail);
  }

  private recordOwnedToolSettlement(taskId: string, runId: string, evidence: string, force = false): void {
    const latest = this.store.eventsAll(taskId).reverse().find(event => ['owned_tool_hold', 'owned_tool_settled'].includes(event.kind)
      && (() => { try { return JSON.parse(event.detail).runId === runId; } catch { return false; } })());
    if (latest?.kind !== 'owned_tool_hold' && !force) return;
    this.store.event(taskId, 'owned_tool_settled', JSON.stringify({ runId, evidence }));
  }
}
