import { isDeepStrictEqual } from "node:util";
import type { Store } from "../store/store";
import { DEFAULT_STALL_THRESHOLD_MINUTES, type Run, type Task } from "../../shared/contracts";
import type { ActivityReadContext } from "../../shared/task-activity";
import type { ParticipantActivity } from "../../shared/schema/task-activity";
import type { AgentObservation } from "../host/adapter";
import type { TimelineEntry } from "../host/types";
import { recordedRunProvider } from "../machine/run-process-hosts";
import { observedParticipantProcess, participantProcessLiveness } from "../machine/participant-process-observation";

type Participant = Pick<ParticipantActivity, "runId" | "agentId">;

export function observeParticipantActivity(
  binding: Participant,
  previous: ParticipantActivity | null | undefined,
  state: AgentObservation,
  at: string,
  tool?: ParticipantActivity["tool"],
): ParticipantActivity {
  const retained = previous?.runId === binding.runId && previous.agentId === binding.agentId ? previous : null;
  const turnId = state.activeTurnId ?? null;
  const sameTurn = retained !== null && retained.turnId === turnId;
  const kind = state.pendingRequest?.kind ?? state.pendingPermissionKinds?.[0] ?? "permission";
  return {
    ...binding,
    turnId,
    ...(state.archived || state.status === "gone" ? { threadGone: true as const } : {}),
    turnStartedAt: turnId || state.active ? state.turnStartedAt ?? (sameTurn ? retained?.turnStartedAt : null) ?? at : null,
    permission: state.permissions
      ? (sameTurn && retained.permission?.kind === kind ? retained.permission : { kind, since: at })
      : null,
    tool: tool === undefined ? (sameTurn ? retained.tool : null) : tool,
    process: observedParticipantProcess(binding.runId) ?? retained?.process ?? null,
  };
}

export function workerActivityObservation(
  task: Task, state: AgentObservation, at: string,
) {
  if (!task.runId || task.agentId !== state.id) return undefined;
  return observeParticipantActivity({ runId: task.runId, agentId: state.id }, task.participantActivity, state, at);
}

export function runActivityObservation(run: Run, state: AgentObservation, at: string) {
  return observeParticipantActivity({ runId: run.id, agentId: state.id }, run.participantActivity, state, at);
}

/** Observe the current tool independently of whether stall detection fences on its kind. */
export function observeRunningTool(
  timeline: readonly TimelineEntry[],
  turnId: string | null,
  include: (entry: TimelineEntry) => boolean = () => true,
): ParticipantActivity["tool"] {
  const calls = new Map<string, TimelineEntry[]>();
  for (const entry of timeline) {
    if (entry.item.type !== "tool_call" || !include(entry) || (turnId && entry.turnId && entry.turnId !== turnId)) continue;
    if (typeof entry.item.callId !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) continue;
    const rows = calls.get(entry.item.callId) ?? [];
    rows.push(entry);
    calls.set(entry.item.callId, rows);
  }
  for (const [callId, rows] of calls) {
    rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const latest = rows.at(-1);
    if (!latest || latest.item.status !== "running" || rows.at(-2)?.timestamp === latest.timestamp) continue;
    const createdAt = latest.item.detail?.startedAt ?? latest.item.createdAt;
    const reportedOutput = latest.item.detail?.lastOutputAt ?? latest.item.lastOutputAt;
    const startedAt = validTimestamp(createdAt) ?? rows[0].timestamp;
    const lastOutputAt = validTimestamp(reportedOutput) ?? rows.findLast(row =>
      typeof row.item.detail?.output === "string" && row.item.detail.output.length > 0)?.timestamp ?? null;
    const name = latest.item.detail?.type === "shell" ? latest.item.detail.command : latest.item.name;
    return { callId, name: (name || "tool").split(/\r?\n/, 1)[0].trim().slice(0, 120) || "tool", startedAt, lastOutputAt };
  }
  return null;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Attach a timeline sample only to the binding and turn that still own it. */
export function recordActivityTool(
  store: Store,
  taskId: string,
  runId: string,
  agentId: string,
  turnId: string | null,
  tool: ParticipantActivity["tool"],
): void {
  const task = store.taskOrNull(taskId);
  if (!task) return;
  const run = store.run(runId);
  if (run ? run.taskId !== taskId || run.released || run.agentId !== agentId : task.runId !== runId || task.agentId !== agentId) return;
  const prior = run ? run.participantActivity : task.participantActivity;
  if (!prior || prior.runId !== runId || prior.agentId !== agentId || prior.turnId !== turnId) return;
  // A short window may lose the first running row without losing the call itself.
  if (tool && prior.tool?.callId === tool.callId) {
    tool = {
      ...tool,
      startedAt: Date.parse(prior.tool.startedAt) < Date.parse(tool.startedAt) ? prior.tool.startedAt : tool.startedAt,
      lastOutputAt: tool.lastOutputAt ?? prior.tool.lastOutputAt,
    };
  }
  if (isDeepStrictEqual(prior.tool, tool)) return;
  const participantActivity = { ...prior, tool };
  if (run) store.putRun({ ...run, participantActivity });
  else store.update(taskId, { participantActivity });
  store.advanceRevision();
}

/** The read surfaces use existing observation rows and the latest local sample. */
export function activityReadContext(store: Store): ActivityReadContext {
  return {
    paused: store.getMeta<boolean>("paused"),
    dispatchHeld: store.getMeta<boolean>("dispatchHeld"),
    quietMs: (store.getMeta<number>("stallThresholdMinutes") ?? DEFAULT_STALL_THRESHOLD_MINUTES) * 60_000,
    processLiveness: (process, now, binding) => {
      const retained = process ?? recordedRunProvider(store, binding);
      return participantProcessLiveness(retained, now);
    },
  };
}
