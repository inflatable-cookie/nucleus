import type { Run, Task } from "../../shared/contracts";
import type { ParticipantActivity } from "../../shared/schema/task-activity";
import type { Resolution } from "../resolution";
import {
  HUNG_TOOL_GRACE_MS,
  selectHungTool,
  terminateHungTool,
  type HungToolSignals,
} from "../machine/hung-tool";
import { bbThreadForAgent } from "../machine/owned-tool-process-proof";
import { participantRuntime, storeDataHome } from "../machine/participant-runtime";

/** One coalesced timeline peek of a participant's current turn. */
export interface ShellPeek {
  notice: string | null;
  live: boolean;
  turnId: string | null;
  tool?: ParticipantActivity["tool"];
  /** The running tool call is a shell command, so it has a process to stop. */
  shellCall?: boolean;
  /** When the timeline behind this peek was read. */
  at?: number;
}

/** How long after a stop the provider has to report the call failed before the call reads as still running. */
export const HUNG_TOOL_REPORT_WINDOW_MS = 60_000;

/** `terminated`: this pass stopped the command. `unterminated`: it is past the limit and still running. */
export type HungToolVerdict = "none" | "terminated" | "unterminated";

export const HUNG_TOOL_TERMINATED = "hung_tool_terminated";
export const HUNG_TOOL_UNTERMINATED = "hung_tool_unterminated";

type HungToolContext = Pick<Resolution, "adapter" | "store">;

/**
 * Spec 068 §4 and Decision 3: a participant's shell command with no output for
 * the repository's `toolQuietLimitMinutes` is terminated, by its own process
 * identity, once per tool call. The turn and the agent are never touched: the
 * agent sees a failed tool call and continues. Every outcome is one event per
 * call, so the task history shows what happened and a repeat pass writes nothing.
 */
export class HungTools {
  /** SIGTERM grace before SIGKILL; tests shorten it. */
  graceMs = HUNG_TOOL_GRACE_MS;
  /** Test seam over the signal and identity reads; production uses the real ones. */
  signals: Omit<HungToolSignals, "graceMs"> = {};
  constructor(private readonly context: HungToolContext) {}

  async settle(task: Task, run: Run | null, runId: string, agentId: string, peek: ShellPeek): Promise<HungToolVerdict> {
    const tool = peek.tool;
    if (!tool || !peek.shellCall) return "none";
    const store = this.context.store;
    const quietSince = Date.parse(tool.lastOutputAt ?? tool.startedAt);
    const limitMs = store.toolQuietLimitMsFor(task);
    if (!Number.isFinite(quietSince) || Date.now() - quietSince < limitMs) return "none";
    // A call already stopped once is never signalled again. Until a timeline
    // read a provider-report window after the stop, it reads as stopped; still
    // running after that, the turn is judged by ordinary stall detection.
    const recorded = this.recorded(task.id, runId, tool.callId);
    const stoppedAt = recorded.get(HUNG_TOOL_TERMINATED);
    if (stoppedAt !== undefined)
      return (peek.at ?? Date.now()) < stoppedAt + HUNG_TOOL_REPORT_WINDOW_MS ? "terminated" : "unterminated";
    const quietMinutes = Math.floor((Date.now() - quietSince) / 60_000);
    const base = { runId, agentId, callId: tool.callId, command: tool.name, quietMinutes, limitMinutes: Math.round(limitMs / 60_000) };
    const unterminated = (reason: string): HungToolVerdict => {
      if (!recorded.has(HUNG_TOOL_UNTERMINATED))
        store.event(task.id, HUNG_TOOL_UNTERMINATED, JSON.stringify({ ...base, reason }).slice(0, 4000));
      return "unterminated";
    };
    const listing = this.context.adapter.hostProcessListing;
    if (!listing) return unterminated("this host offers no process listing");
    const processes = await listing.call(this.context.adapter).catch(() => null);
    const thread = bbThreadForAgent(agentId, run?.hostId ?? task.hostId);
    const runtime = participantRuntime({
      dataHome: storeDataHome(store),
      tasks: [task],
      runs: store.runs(task.id),
      bbThreads: thread ? [thread] : [],
    });
    const selection = selectHungTool(runId, tool.name, processes, runtime);
    if ("refusal" in selection) return unterminated(selection.refusal);
    const { target } = selection;
    const stopped = await terminateHungTool(target, { ...this.signals, graceMs: this.graceMs });
    const process = { kind: target.kind, pid: target.root.pid, pgid: target.root.pgid, startIdentity: target.root.startIdentity };
    if (stopped.outcome === "identity_changed")
      return unterminated(`pid ${target.root.pid} no longer carries start identity ${target.root.startIdentity}; nothing was signalled`);
    if (stopped.outcome === "survived")
      return unterminated(`pids ${stopped.survivors.join(", ")} survived SIGTERM and SIGKILL (${JSON.stringify(process)})`);
    store.event(task.id, HUNG_TOOL_TERMINATED, JSON.stringify({ ...base, ...process, signalled: stopped.signalled, killed: stopped.killed }).slice(0, 4000));
    return "terminated";
  }

  /** The hung-tool outcomes already recorded for this exact call, with when each was first recorded. */
  private recorded(taskId: string, runId: string, callId: string): Map<string, number> {
    const kinds = new Map<string, number>();
    for (const event of this.context.store.eventsAll(taskId)) {
      if (event.kind !== HUNG_TOOL_TERMINATED && event.kind !== HUNG_TOOL_UNTERMINATED) continue;
      try {
        const detail = JSON.parse(event.detail) as { runId?: unknown; callId?: unknown };
        if (detail.runId === runId && detail.callId === callId && !kinds.has(event.kind))
          kinds.set(event.kind, Date.parse(event.at) || 0);
      } catch {
        /* a truncated detail names no call */
      }
    }
    return kinds;
  }
}
