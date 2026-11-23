import { dispatchBlocked } from "../dispatch/capacity";
import {
  participantProcessDeath,
  participantProcessLiveness,
  type ProcessDeathEvidence,
} from "../machine/participant-process-observation";
import { recordedRunProvider } from "../machine/run-process-hosts";
import type { Store } from "../store/store";
import { releasePlan } from "../verbs/explicit-resolution";
import { prIdentity } from "../verbs/owner-facts";
import {
  WORKER_REPLACEMENT_CEILING,
  type Run,
  type Task,
} from "../../shared/contracts";
import type {
  ParticipantActivity,
  ParticipantProcess,
} from "../../shared/schema/task-activity";
import type { ExplicitResolution } from "../../shared/schema/task-control";
import type { Engine } from "../engine";
import { isAgentGoneRefusal, ThreadUnobservedError } from "../host/errors";

/**
 * Spec 068 §3: a participant whose agent is provably dead is not work.
 *
 * Two facts prove death, and nothing else does:
 *
 * - **Process facts.** Its own recorded process is gone: the PID is absent from
 *   a complete process table, a different process holds that PID, it is a
 *   zombie, or it started before the machine's last boot (nucleus#1552).
 * - **Thread facts.** Its thread is absent or removed on its host,
 *   answered by the host's own exact read: on T3 the live shell inside its
 *   freshness bound, then one exact read by id (`T3Reads.readThreadRecord`).
 *
 * A live recorded process vetoes thread absence (one writer at a time), and an
 * unreadable process table, an unproven start identity, a host that is not
 * available or a read that fails all prove nothing. The released run goes
 * through the ordinary `run.release` plan, its proof is recorded, and ordinary
 * admission relaunches the role: a fresh reviewer at the same head, a revision
 * on the retained worker thread (or a fresh worker when that thread is gone).
 *
 * Each role gets at most `DEAD_PARTICIPANT_ATTEMPTS` automatic releases at one
 * head; past that the task records a typed stop naming its explicit command.
 */

export const DEAD_PARTICIPANT_ATTEMPTS = 3;

/**
 * A host read that failed because the host no longer has (or no longer serves)
 * the thread. It is only a reason to look: the proof is the exact read below.
 */
export function threadGoneError(error: unknown): boolean {
  return isAgentGoneRefusal(error) || error instanceof ThreadUnobservedError;
}

// An archived thread is not death: a retained thread can be resumed from its
// archive, and observation already treats a closed retained thread as resumable.
export type ThreadDeathEvidence = "thread_absent" | "thread_deleted";
export type DeathEvidence = ProcessDeathEvidence | ThreadDeathEvidence;

/** The proof one release names, kept in the event that records it. */
export interface DeadParticipantProof {
  runId: string;
  taskId: string;
  role: Run["role"] | "worker";
  agentId: string | null;
  head: string | null;
  evidence: DeathEvidence;
  process: { pid: number; startIdentity: string; seenAt: number | null } | null;
}

export type DeadParticipantContext = Pick<
  Engine,
  "store" | "host" | "resolution" | "withHost"
>;

function boundActivity(
  activity: ParticipantActivity | null | undefined,
  runId: string | null | undefined,
  agentId: string | null | undefined,
): ParticipantActivity | null {
  return activity &&
    runId &&
    agentId &&
    activity.runId === runId &&
    activity.agentId === agentId
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
  return (
    activity?.process ?? recordedRunProvider(store, { taskId: task.id, runId })
  );
}

/**
 * The host's own answer that this thread can take no further turn, or null. Only
 * a positive answer counts: a host that is not available, or a read that fails,
 * proves nothing.
 */
export async function threadDeathEvidence(
  ctx: DeadParticipantContext,
  task: Task,
  run: Run | null,
  agentId: string,
): Promise<ThreadDeathEvidence | null> {
  if (!ctx.resolution.hostAvailable(task, run ?? undefined)) return null;
  try {
    const origin = await ctx.resolution.onTaskHost(run ?? task, () =>
      ctx.host.originAgent(agentId),
    );
    if (!origin) return "thread_absent";
    if (origin.deleted) return "thread_deleted";
    return null;
  } catch {
    return null;
  }
}

/**
 * Proof that this participant's agent is dead, or null. Only the participant
 * named by `run` (or the retained worker when `run` is null) is read: another
 * participant's facts are never evidence about this one.
 */
export async function deadParticipantProof(
  ctx: DeadParticipantContext,
  task: Task,
  run: Run | null,
  at = Date.now(),
): Promise<DeadParticipantProof | null> {
  const runId = run?.id ?? task.runId;
  const agentId = run ? run.agentId : task.agentId;
  if (!runId) return null;
  const process = recordedParticipantProcess(ctx.store, task, run);
  const base = {
    runId,
    taskId: task.id,
    role: run?.role ?? ("worker" as const),
    agentId: agentId ?? null,
    head: run?.head ?? task.prHead ?? null,
    process: process
      ? {
          pid: process.pid,
          startIdentity: process.startIdentity,
          seenAt: process.seenAt ?? null,
        }
      : null,
  };
  // A live recorded process is a writer, whatever its thread's display says.
  if (participantProcessLiveness(process, at) === "alive") return null;
  const processEvidence = participantProcessDeath(process, at);
  if (processEvidence) return { ...base, evidence: processEvidence };
  if (!agentId) return null;
  const threadEvidence = await threadDeathEvidence(ctx, task, run, agentId);
  return threadEvidence ? { ...base, evidence: threadEvidence } : null;
}

/** Process facts alone, with no host read: the stall path's cheap first look. */
export function processDeathProof(
  store: Store,
  task: Task,
  run: Run | null,
  at = Date.now(),
): DeadParticipantProof | null {
  const runId = run?.id ?? task.runId;
  if (!runId) return null;
  const process = recordedParticipantProcess(store, task, run);
  const evidence = participantProcessDeath(process, at);
  if (!process || !evidence) return null;
  return {
    runId,
    taskId: task.id,
    role: run?.role ?? "worker",
    agentId: (run ? run.agentId : task.agentId) ?? null,
    head: run?.head ?? task.prHead ?? null,
    process: {
      pid: process.pid,
      startIdentity: process.startIdentity,
      seenAt: process.seenAt ?? null,
    },
    evidence,
  };
}

/** One sentence naming the proof, for the event and for the release's reason. */
export function deadParticipantDetail(proof: DeadParticipantProof): string {
  const why = {
    pre_boot: "its process started before the machine's last boot",
    pid_absent: "no process holds its PID in a complete process table",
    start_identity_changed: "a different process now holds its PID",
    zombie: "its process is a zombie",
    thread_absent: "its thread is absent from a complete host read",
    thread_deleted: "its thread was removed on its host",
  }[proof.evidence];
  const process = proof.process
    ? ` (process pid ${proof.process.pid}, start identity ${proof.process.startIdentity})`
    : "";
  return `${proof.role} run ${proof.runId}${proof.agentId ? ` on thread ${proof.agentId}` : ""}${process} is gone: ${why}`;
}

const threadEvidence = (evidence: DeathEvidence): boolean =>
  evidence === "thread_absent" || evidence === "thread_deleted";

/** The proof is the only authority this path asks for; a coordinator has its own. */
function coordinatorOwnsTask(store: Store, task: Task): boolean {
  const recovery = task.resolution.recovery;
  if (recovery && recovery.status !== "resolved") return true;
  return store
    .runs(task.id)
    .some(
      (run) =>
        !run.released &&
        (run.role === "recovery" ||
          run.role === "verification" ||
          run.role === "closeout"),
    );
}

/** Automatic releases already made for this role at this head (the per-cause bound). */
function releasesAtHead(
  store: Store,
  taskId: string,
  role: string,
  head: string | null,
): number {
  return store
    .eventsAll(taskId)
    .filter((event) => event.kind === "participant_gone")
    .filter((event) => {
      try {
        const detail = JSON.parse(event.detail) as {
          role?: string;
          head?: string | null;
        };
        return detail.role === role && (detail.head ?? null) === head;
      } catch {
        return false;
      }
    }).length;
}

/** Retire the task's retained worker into its history, so the next revision starts fresh. */
function retireWorkerPatch(task: Task, reason: string): Partial<Task> {
  if (!task.agentId) return {};
  return {
    agentId: null,
    agentIntent: false,
    agentActive: false,
    ...(task.profile && task.runId
      ? {
          retiredWorkers: [
            ...task.retiredWorkers,
            {
              agentId: task.agentId,
              runId: task.runId,
              profile: task.profile,
              reason,
              ...(task.hostId ? { hostId: task.hostId } : {}),
            },
          ],
        }
      : {}),
  };
}

/**
 * Release the participant whose agent is provably dead, through the same
 * `releasePlan` an owner `run.release` applies, and record the proof. Ordinary
 * admission then relaunches the role. Returns whether it released.
 */
export async function releaseDeadParticipant(
  ctx: DeadParticipantContext,
  task: Task,
  run: Run | null,
): Promise<boolean> {
  const store = ctx.store;
  const current = store.task(task.id);
  if (current.removedAt || ["done", "cancelled"].includes(current.phase))
    return false;
  // An operator hold owns the task until it is lifted.
  if (dispatchBlocked(current)) return false;
  // One owner at a time: a coordinator run or recovery episode owns the next move.
  if (coordinatorOwnsTask(store, current)) return false;
  const target = run ? store.run(run.id) : null;
  if (run) {
    if (!target || target.taskId !== current.id || target.released)
      return false;
    if (target.role !== "reviewer" && target.role !== "revision") return false;
    // A run that already reported is settled by its completion, not by this rule.
    if (target.completion) return false;
  } else {
    if (!current.runId || current.completion) return false;
  }
  const proof = await deadParticipantProof(ctx, current, target);
  if (!proof) return false;
  const latestTask = store.task(current.id);
  if (latestTask.version !== current.version) return false;
  const detail = deadParticipantDetail(proof);
  if (
    releasesAtHead(store, current.id, proof.role, proof.head) >=
    DEAD_PARTICIPANT_ATTEMPTS
  ) {
    const role = proof.role === "reviewer" ? "reviewer" : "worker";
    const command = `run.start ${role} fresh replacing=${proof.runId}`;
    const reason = `${detail}. Nucleus already relaunched this ${role} ${DEAD_PARTICIPANT_ATTEMPTS} times at this head; use ${command} or run.release run=${proof.runId}`;
    if (latestTask.reason !== reason)
      ctx.resolution.waiting(latestTask, reason, "operator_needed", {
        fact: { code: "participant_gone", subject: proof.runId },
      });
    return false;
  }
  const reason = `Nucleus released this run on proof that its agent is gone (Spec 068): ${detail}. Ordinary admission relaunches the role.`;
  const input: Extract<ExplicitResolution, { action: "run.release" }> = {
    taskId: current.id,
    version: current.version,
    action: "run.release",
    run: proof.runId,
    reason,
    caller: "queue",
    // The proof answers the live-turn warning; the run never reported.
    accept: ["live_turn", "unreported_result"],
  };
  let plan: ReturnType<typeof releasePlan> | null = null;
  try {
    plan = store.transaction(() => {
      const latest = store.task(current.id);
      if (latest.version !== current.version) return null;
      const release = releasePlan(ctx, latest, input);
      const { patch } = release.apply();
      // A revision whose worker thread is gone also retires that worker, so the
      // revision admission starts a fresh one without another host read.
      const retire =
        target?.role === "revision" &&
        threadEvidence(proof.evidence) &&
        latest.agentId === target.agentId
          ? retireWorkerPatch(latest, detail)
          : {};
      const released = store.update(
        latest.id,
        { ...(patch ?? {}), ...retire },
        "owner_resolution",
        JSON.stringify({
          command: "run.release",
          arguments: { run: proof.runId },
          caller: "queue",
          source: "queue",
          reason,
          warnings: release.warnings.map((warning) => warning.id),
          accepted: input.accept,
          proof,
        }),
      );
      store.event(latest.id, "participant_gone", JSON.stringify(proof));
      if (run) return release;
      // The released run was this task's own worker binding, and no phase
      // admission owns a working task with no worker.
      if (!prIdentity(released) && !released.completion) {
        // Nothing published yet: ordinary dispatch on the retained worktree.
        ctx.resolution.returnToDispatch(
          released,
          false,
          `${detail}. The worker returned to ordinary dispatch on its retained worktree.`,
          "worker_process_gone_redispatch",
        );
      } else {
        // A published PR continues on a fresh worker through the ordinary
        // revision admission, with the worker's own continuation.
        const retired = store.update(
          released.id,
          {
            ...(latest.agentId && latest.profile && latest.runId
              ? {
                  retiredWorkers: [
                    ...released.retiredWorkers,
                    {
                      agentId: latest.agentId,
                      runId: latest.runId,
                      profile: latest.profile,
                      reason: detail,
                      ...(latest.hostId ? { hostId: latest.hostId } : {}),
                    },
                  ],
                }
              : {}),
            resumePrNumber:
              released.resumePrNumber ??
              released.completion?.prNumber ??
              prNumberOf(released.prUrl),
          },
        );
        const action = ctx.resolution.workerContinuation(retired);
        ctx.resolution.update(
          retired,
          {
            currentRunId: null,
            attention: false,
            stalledTurnStop: null,
            pendingWorkerInstruction: action,
            stop: null,
          },
          { phase: "changes_requested", reason: `Worker action requested: ${action}` },
          "worker_gone_fresh_continuation",
          detail,
        );
      }
      return release;
    });
  } catch (error) {
    store.event(
      current.id,
      "participant_release_refused",
      `${proof.runId}: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        4000,
      ),
    );
    return false;
  }
  if (!plan) return false;
  await plan.finish?.();
  return true;
}

function prNumberOf(url: string | null | undefined): number | null {
  const match = url ? /\/pull\/(\d+)(?:$|[/?#])/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Spec 068 §3 (gap: a dead retained worker): before a revision launch observes
 * the retained worker, a thread its host positively reports absent or
 * removed is retired into the task's history with that proof, so the launch
 * continues the same revision on a fresh worker instead of waiting on a thread
 * that can never answer. A live recorded process vetoes the retirement. Past the
 * worker replacement ceiling the task records a typed stop naming
 * `run.start worker fresh` instead. Returns whether the worker was retired.
 */
export async function retireGoneRetainedWorker(
  ctx: DeadParticipantContext,
  task: Task,
): Promise<boolean> {
  const store = ctx.store;
  const current = store.task(task.id);
  const agentId = current.agentId;
  if (!agentId || current.phase !== "changes_requested") return false;
  // The retained worker is serving an unreleased run: that run's own observation
  // owns its death, never this launch.
  if (
    store
      .runs(current.id)
      .some((run) => !run.released && run.agentId === agentId)
  )
    return false;
  const process = recordedParticipantProcess(store, current, null);
  if (participantProcessLiveness(process, Date.now()) === "alive") return false;
  const evidence = await threadDeathEvidence(ctx, current, null, agentId);
  if (!evidence) return false;
  const latest = store.task(current.id);
  if (latest.version !== current.version || latest.agentId !== agentId)
    return false;
  const proof: DeadParticipantProof = {
    runId: latest.runId ?? "",
    taskId: latest.id,
    role: "worker",
    agentId,
    head: latest.prHead ?? null,
    evidence,
    process: process
      ? {
          pid: process.pid,
          startIdentity: process.startIdentity,
          seenAt: process.seenAt ?? null,
        }
      : null,
  };
  const detail = `retained worker ${agentId} is gone: ${
    {
      thread_absent: "its thread is absent from a complete host read",
      thread_deleted: "its thread was removed on its host",
    }[evidence]
  }`;
  if (latest.retiredWorkers.length >= WORKER_REPLACEMENT_CEILING) {
    const reason = `The ${detail}, and the task reached its worker replacement ceiling; use run.start worker fresh to continue the revision on a fresh worker`;
    if (latest.reason !== reason)
      ctx.resolution.waiting(latest, reason, "operator_needed", {
        fact: { code: "participant_gone", subject: agentId },
      });
    return false;
  }
  store.transaction(() => {
    store.update(
      latest.id,
      retireWorkerPatch(
        latest,
        `${detail}; the revision continues on a fresh worker (Spec 068)`,
      ),
      "retained_worker_gone",
      JSON.stringify(proof),
    );
  });
  return true;
}
