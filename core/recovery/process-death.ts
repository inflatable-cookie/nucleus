import { dispatchBlocked } from "../dispatch/capacity";
import {
  participantProcessDeath,
  type ProcessDeathEvidence,
} from "../machine/participant-process-observation";
import { recordedRunProvider } from "../machine/run-process-hosts";
import type { Store } from "../store/store";
import { releasePlan } from "../verbs/explicit-resolution";
import type { ParticipantActivity, ParticipantProcess } from "../../shared/schema/task-activity";
import type { Run, Task } from "../../shared/contracts";
import type { Engine } from "../engine";
import type { ExplicitResolution } from "../../shared/schema/task-control";

/**
 * Spec 068 §3: process facts are liveness evidence.
 *
 * A run or retained worker whose recorded process is positively gone is not
 * work: no turn it could take will ever report. Nucleus releases exactly that
 * participant through the ordinary `run.release` plan and records the proof, so
 * ordinary admission relaunches the role on its own thread (a retained worker)
 * or a fresh one (a reviewer).
 *
 * The proof is the authority here, so this path asks no owner: it releases only
 * the one participant whose own recorded process is gone. A live process, an
 * unreadable process table, a sample older than the record, or an unprovable
 * start identity all prove nothing and leave the run leased. A run that already
 * reported is settled by its completion, never here.
 */

/** The proof one release names, kept in the event that records it. */
export interface ProcessDeathProof {
  runId: string;
  taskId: string;
  role: Run["role"] | "worker";
  agentId: string | null;
  pid: number;
  startIdentity: string;
  seenAt: number | null;
  evidence: ProcessDeathEvidence;
}

export type ProcessDeathContext = Pick<Engine, "store" | "host" | "withHost">;

function boundActivity(
  activity: ParticipantActivity | null | undefined,
  runId: string | null | undefined,
  agentId: string | null | undefined,
): ParticipantActivity | null {
  return activity && runId && agentId &&
    activity.runId === runId && activity.agentId === agentId
    ? activity
    : null;
}

/**
 * The process identity Nucleus recorded for one participant: its own activity
 * row first, then the host-run observation that names the provider behind it.
 * A retained worker's process lives on the task row, a run's on its run row.
 */
export function recordedParticipantProcess(
  store: Store,
  task: Task,
  run: Run | null,
): ParticipantProcess | null {
  const runId = run?.id ?? task.runId;
  if (!runId) return null;
  const activity = run
    ? boundActivity(run.participantActivity, run.id, run.agentId)
    : boundActivity(task.participantActivity, task.runId, task.agentId);
  return activity?.process ?? recordedRunProvider(store, { taskId: task.id, runId });
}

/**
 * The proof that this participant's own process is gone, or null. Only the
 * participant named by `run` (or the retained worker when `run` is null) is
 * read: another participant's live process is never evidence about this one.
 */
export function processDeathProof(
  store: Store,
  task: Task,
  run: Run | null,
  at = Date.now(),
): ProcessDeathProof | null {
  const runId = run?.id ?? task.runId;
  const agentId = run?.agentId ?? (run ? null : task.agentId);
  if (!runId) return null;
  const process = recordedParticipantProcess(store, task, run);
  const evidence = participantProcessDeath(process, at);
  if (!process || !evidence) return null;
  return {
    runId,
    taskId: task.id,
    role: run?.role ?? "worker",
    agentId: agentId ?? null,
    pid: process.pid,
    startIdentity: process.startIdentity,
    seenAt: process.seenAt ?? null,
    evidence,
  };
}

/** One sentence naming the proof, for the event and for the release's reason. */
export function processDeathDetail(proof: ProcessDeathProof): string {
  const why = {
    pre_boot: "it started before the machine's last boot",
    pid_absent: "no process holds its PID in a complete process table",
    start_identity_changed: "a different process now holds its PID",
    zombie: "it is a zombie process",
  }[proof.evidence];
  return `${proof.role} run ${proof.runId} (process pid ${proof.pid}, start identity ${proof.startIdentity}) is gone: ${why}`;
}

/**
 * Release the participant whose recorded process is provably gone, through the
 * same `releasePlan` an owner `run.release` applies, and record the proof.
 * Ordinary admission then relaunches the role.
 */
export async function releaseGoneProcess(
  engine: ProcessDeathContext,
  task: Task,
  run: Run | null,
): Promise<boolean> {
  const store = engine.store;
  const current = store.task(task.id);
  if (current.removedAt) return false;
  // An operator hold owns the task until it is lifted; a release would answer a
  // stop the operator did not make.
  if (dispatchBlocked(current)) return false;
  const target = run ? store.run(run.id) : null;
  if (run) {
    if (!target || target.taskId !== current.id || target.released) return false;
    // A run that already reported is settled by its completion, not by this rule.
    if (target.completion) return false;
  } else {
    if (!current.runId) return false;
    if (current.completion) return false;
  }
  const proof = processDeathProof(store, current, target);
  if (!proof) return false;
  const version = current.version;
  const reason = `Nucleus released this run on proof of process death (Spec 068): ${processDeathDetail(proof)}. Ordinary admission relaunches the role.`;
  const input: Extract<ExplicitResolution, { action: "run.release" }> = {
    taskId: current.id,
    version,
    action: "run.release",
    run: proof.runId,
    reason,
    caller: "queue",
    // The release plan warns about a possibly live turn and an unreported
    // result. This path's proof answers the first and accepts the second: the
    // run never reported and its process is gone.
    accept: ["live_turn", "unreported_result"],
  };
  let plan: ReturnType<typeof releasePlan> | null = null;
  try {
    plan = store.transaction(() => {
      const latest = store.task(current.id);
      if (latest.version !== version) return null;
      const release = releasePlan(engine, latest, input);
      const { patch } = release.apply();
      store.update(latest.id, patch ?? {}, "owner_resolution", JSON.stringify({
        command: "run.release",
        arguments: { run: proof.runId },
        caller: "queue",
        source: "queue",
        reason,
        warnings: release.warnings.map((warning) => warning.id),
        accepted: input.accept,
        process: proof,
      }));
      store.event(latest.id, "participant_process_gone", JSON.stringify(proof));
      return release;
    });
  } catch (error) {
    store.event(
      current.id,
      "participant_process_release_refused",
      `${proof.runId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000),
    );
    return false;
  }
  if (!plan) return false;
  await plan.finish?.();
  return true;
}
