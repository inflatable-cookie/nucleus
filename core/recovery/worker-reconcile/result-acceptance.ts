import { admitPhaseFacts } from "../../scheduling/phase-latency";
import {
  parseAgentId,
  sameCallerIdentity,
} from "../../../shared/agent-identity";
import type { Completion, Task } from "../../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../../shared/lanes";
import {
  recordResultApplied,
  resultApplied,
} from "../../intake/applied-result";
import { settlementHeld } from "../../closeout/queue-drain";
import { continuationOwnsReturn } from "./blocked-return";
import { hookHoldReason } from "../../hooks/hooks";
import type { Adapter } from "../../host/adapter";
import type { WorkerReconcileContext } from "./context";
import { PR_HEAD_CHANGED_REASON } from "../task-reasons";

/**
 * Taking the worker's recorded result: hold a report for its planner, verify a
 * PR report, or record a blocked or error return. The lane-level facts (phase,
 * reason, PR identity) move in one transaction that re-checks the receipt it
 * consumed, so a second pass cannot apply the same result twice.
 */

/** Hold a report_ready result for planner acceptance and tell the planner once. */
async function announceReportReady(
  engine: WorkerReconcileContext,
  current: Task,
): Promise<void> {
  const { store, adapter, resolution } = engine;
  const completion = current.completion!;
  if (current.phase === "report_ready") return;
  const artifact = completion.artifact!;
  const reason = `Planner: report ready — ${completion.summary} (lane ${artifact.key} v${artifact.version}, ${artifact.digest}). Complete this dispatched task with reason and artifact {key, version, digest}, or move it to work with instructions if the report needs revision.`;
  const applied = store.transaction(() => {
    const latest = store.task(current.id);
    if (
      latest.completion?.eventId !== current.completion?.eventId ||
      resultApplied(store, current.id, completion.runId)
    )
      return false;
    store.update(
      current.id,
      { phase: "report_ready", reason, idleSince: null },
      "workspace_released",
      "report_ready",
    );
    recordResultApplied(store, current.id, completion.runId);
    admitPhaseFacts(store, current.id);
    return true;
  });
  if (!applied) return;
  if (
    !adapter.notify ||
    store
      .eventsAll(current.id)
      .some((event) => event.kind === "report_ready_planner_notice_intent")
  )
    return;
  const project = store.projectFor(current.repoPath, normalizeRepositoryOrigin(current.repository ?? ""));
  const { rungs } = await resolution.plannerRungsFor(current);
  const planner = rungs[0]?.agentId;
  if (!planner || store.task(current.id).phase !== "report_ready") return;
  const messageId = `ns-report-ready-${current.id}-${completion.eventId}`;
  store.event(
    current.id,
    "report_ready_planner_notice_intent",
    `${planner}: ${messageId}`,
  );
  try {
    const hostId =
      parseAgentId(planner)?.hostId ??
      (sameCallerIdentity(
        planner,
        current.notificationAgentId ?? current.originAgentId,
      )
        ? current.originHostId
        : await resolution.identifyOriginHost(planner));
    if (!hostId) throw Error("Report acceptance planner host is unknown");
    await resolution.withHost(hostId, () =>
      engine.host.sendMessage(planner, {
        messageId,
        text: `Nucleus: report ready for planner acceptance\nTask: ${current.title} (${current.id})\n${completion.headline ?? completion.summary}\nArtifact: ${artifact.key} v${artifact.version} (${artifact.digest})\nUse the existing complete owner verb with the artifact and an acceptance reason, or move to work with an instruction if the report needs revision. No PR or reviewer was started.`,
      }),
    );
    store.event(current.id, "report_ready_planner_notice_delivered", planner);
  } catch (error) {
    if (project) resolution.responsibleThreads.cache.invalidate(project.key);
    store.event(
      current.id,
      "report_ready_planner_notice_unknown",
      `${planner}: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        4000,
      ),
    );
  }
}

/** The PR identity a ready report names, verified live; a changed head is refused. */
async function verifiedPrIdentity(
  engine: WorkerReconcileContext,
  current: Task,
  c: Completion,
): Promise<Task | null> {
  let pr: Awaited<ReturnType<NonNullable<Adapter["verifyPr"]>>>;
  try {
    pr = await engine.adapter.verifyPr(current, c.prNumber!);
  } catch (error) {
    const handled = engine.store.transaction(() => {
      const latest = engine.store.task(current.id);
      if (
        resultApplied(engine.store, current.id, c.runId) ||
        latest.runId !== c.runId ||
        latest.completion?.eventId !== c.eventId
      )
        return true;
      if (
        !engine.resolution.responsiblePrReportRefused(
          latest,
          c.runId,
          c.prNumber!,
          error,
        )
      )
        return false;
      recordResultApplied(engine.store, current.id, c.runId);
      return true;
    });
    if (handled) return null;
    throw error;
  }
  if (settlementHeld(engine.store, engine.stopped)) return null;
  if (current.prHead && pr.head !== current.prHead)
    throw new Error(PR_HEAD_CHANGED_REASON);
  return { ...current, prHead: pr.head, prUrl: pr.url };
}

/** Take the worker's recorded result: hold a report for its planner, verify a PR report, or record a blocked or error return. */
export async function acceptWorkerResult(
  engine: WorkerReconcileContext,
  task: Task,
  current: Task,
): Promise<void> {
  if (
    current.completion &&
    resultApplied(engine.store, task.id, current.completion.runId)
  )
    return;
  if (current.completion?.status === "report_ready") {
    await announceReportReady(engine, current);
    return;
  }
  const { store, resolution, hooks } = engine;
  const c = current.completion!;
  current = await engine.compareSiblings(current, c.eventId);
  if (c.status === "ready_for_review") {
    const verified = await verifiedPrIdentity(engine, current, c);
    // A refused or unreadable verification was recorded above; a held settlement ends the pass.
    if (!verified) return;
    current = verified;
  }
  if (c.status !== "ready_for_review") {
    const hookState = await hooks.emit("task.blocked", current, {
      event: "task.blocked",
      summary: c.summary,
      delivery: {
        prUrl: current.prUrl,
        prNumber: c.prNumber ?? null,
        head: current.prHead,
        review: current.resolution.review?.summary ?? null,
        summary: c.summary,
      },
    });
    if (hookState.hold) {
      engine.note(
        task.id,
        hookHoldReason(hookState),
        "operator_needed",
        "needs_attention",
      );
      return;
    }
    current = resolution.settleAutomaticReplayHold(
      current,
      hookState.records,
      "task.blocked",
    );
  }
  // A late authenticated result reconciles the stopped-worker incident instead of leaving attention behind.
  const awaitedReminder =
    current.resolution.incident?.runId === current.runId &&
    current.resolution.incident.action === "callback_reminder" &&
    current.resolution.incident.status !== "escalated";
  const stopAttention =
    current.resolution.attention &&
    (awaitedReminder ||
      current.reason ===
        "Worker stopped without a completion callback; inspect the thread");
  // The blocked hook above waited on I/O: a push-back recorded meanwhile owns this return.
  if (
    c.status !== "ready_for_review" &&
    continuationOwnsReturn(engine, task.id)
  )
    return;
  const applied = store.transaction(() => {
    const latest = store.task(task.id);
    if (
      latest.completion?.eventId !== c.eventId ||
      latest.runId !== c.runId ||
      resultApplied(store, task.id, c.runId)
    )
      return false;
    store.update(
      task.id,
      {
        phase:
          c.status === "ready_for_review"
            ? "awaiting_review"
            : c.status === "blocked"
              ? "blocked"
              : "error",
        reason: c.summary,
        idleSince: null,
        ...(c.status === "ready_for_review"
          ? { prHead: current.prHead, prUrl: current.prUrl }
          : {}),
        ...(stopAttention
          ? { resolution: { ...latest.resolution, attention: false } }
          : {}),
      },
      "workspace_released",
      c.status,
    );
    recordResultApplied(store, task.id, c.runId);
    return true;
  });
  if (applied && awaitedReminder)
    resolution.resolveIncident(
      current,
      current.runId,
      "Late authenticated result received",
    );
}
