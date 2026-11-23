import { budgetOutageIntervals } from "../scheduling/host-outage";
import { exhaustedReviewer, exhaustedReviewerRefusal } from "./reviewer-report";
import { ownerStopPendingRefusal } from "./owner-stop";
/** Owner verb registry; read-side admission lives under verbs/. */
import { readyReviewAtHead } from "../recovery/task-reasons";
import {
  completeStateRefusal,
  routeStateRefusal,
  stopStateRefusal,
} from "./control-refusals";
import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import { receiptAcceptanceRefusal } from "../review/proof-receipt-acceptance";
import { workerRouteProfile } from "../../shared/pool";
import {
  reviewerFiltersWorker,
  reviewerIndependenceFilter,
} from "../dispatch/routing";
import { proofActivationPreview } from "../qa/proof-activation";
import {
  openProofOnlyGo,
  PROOF_GO_WAIT_REFUSAL,
  PROOF_GO_WAIT_VERBS,
} from "../qa/proof-only-go";
import { taskBudget } from "../../shared/task-budget";
import { z } from "zod";
import {
  cancellationWithdrawalRefusal,
  dependencyIdsSchema,
  holdsOf,
  taskControlInputSchema,
  taskNextVerbSchema,
  laneDocumentRefSchema,
  type Task,
  type TaskControlInput,
  type TaskNextVerb,
  type TaskNext,
} from "../../shared/contracts";
import { buildOutputDisclosure } from "../../shared/build-output-disclosure";
import { routeRoles, verbInput, applyMapped } from "./owner-shared";
import type { RouteRole, OwnerVerb } from "./owner-shared";
import { replacementAllowanceNote, durableRunFence } from "./owner-facts";
import {
  effectiveDefaultHostKind,
  hostKindOf,
  type HostKind,
} from "../../shared/host-kind";
import type { OwnerVerbFacts } from "./owner-facts";
import { assembleOwnerTaskNext } from "./task-next";
import { restart } from "./owner-restart";
import { move, moveTargets } from "./owner-move";
import { retryEffect, ownerPendingEffects } from "./owner-effects";

/** The role's current route profile, or null when the task records none. */
export function currentRouteProfile(
  task: Pick<
    Task,
    "profile" | "profileRequests" | "preferredProfileId" | "resolution"
  >,
  role: RouteRole,
): string | null {
  if (role === "worker") return workerRouteProfile(task);
  if (role === "reviewer")
    return (
      task.profileRequests?.reviewer?.profileId ??
      task.resolution.reviewerProfile?.id ??
      null
    );
  return task.profileRequests?.coordinator?.profileId ?? null;
}

/**
 * The `next` note for a worker route whose recorded profile review independence
 * filters (`reviewerFiltersWorker`, the rule worker selection applies). Null when
 * the profile may be prefilled, or when the profile is not in the catalog.
 */
function workerRouteFilterNote(
  facts: OwnerVerbFacts,
  profileId: string,
): string | null {
  const worker = profileId
    ? facts.store.profiles().find((profile) => profile.id === profileId)
    : undefined;
  return worker &&
    reviewerFiltersWorker(facts.task.resolution.reviewerProfile, worker)
    ? `${profileId} ${reviewerIndependenceFilter(worker)}; worker selection drops it with no waiver. Pick an eligible worker profile, or route the retained reviewer to a different model first.`
    : null;
}

/** Evaluate whether a worker route profile can run on the task's host or moves to another online host. */
function workerHostRouteView(
  facts: OwnerVerbFacts,
  profileId: string,
): { clearProfile: boolean; note: string | null } {
  if (!profileId || !facts.hostViews?.length)
    return { clearProfile: false, note: null };
  const task = facts.task;
  const poolEntry = facts.store
    .pool()
    .find((entry) => entry.profileId === profileId);
  if (poolEntry && !poolEntry.enabled)
    return {
      clearProfile: true,
      note: `${profileId} is disabled in the pool; choose an available worker profile.`,
    };
  const currentView = facts.hostViews.find((h) => h.hostId === task.hostId);
  const currentEntry = currentView?.profiles.find(
    (entry) => entry.profileId === profileId,
  );
  if (currentView?.online && currentEntry?.eligible)
    return { clearProfile: false, note: null };
  const eligibleOtherHosts = facts.hostViews.filter(
    (host) =>
      host.hostId !== task.hostId &&
      host.online &&
      host.profiles.some(
        (entry) => entry.profileId === profileId && entry.eligible,
      ),
  );
  if (eligibleOtherHosts.length > 0) {
    const preferredKinds = [
      facts.store.repositoryFor(task.repoPath)?.hostKind,
      effectiveDefaultHostKind(
        facts.store.getMeta<HostKind | null>("operatorDefaultHostKind"),
      ),
    ];
    const targetHost =
      preferredKinds.flatMap((kind) =>
        kind
          ? eligibleOtherHosts.filter((h) => hostKindOf(h.hostId) === kind)
          : [],
      )[0] ?? eligibleOtherHosts[0]!;
    return {
      clearProfile: false,
      note: `Routing worker to ${profileId} moves this task from ${task.hostId} to ${targetHost.hostId}.`,
    };
  }
  const reasons = facts.hostViews
    .map((host) => {
      const entry = host.profiles.find((item) => item.profileId === profileId);
      const reason = !host.online
        ? "Host offline"
        : (entry?.reason ?? "Profile absent from host catalog");
      return `${host.hostId}: ${reason}`;
    })
    .join("; ");
  return {
    clearProfile: true,
    note: `${profileId} cannot launch on any online host for this task (${reasons}); choose an available worker profile.`,
  };
}

/** Spec 050 `route`: one read view per role, each prefilled with that role's current profile. */
function routeViews(facts: OwnerVerbFacts): TaskNextVerb[] {
  const task = facts.task;
  const refusal = routeStateRefusal(task);
  // The worker route is the only one that can replace a worker, so its view
  // carries the retirement count and the supported ceiling exit.
  const workerNote = replacementAllowanceNote(task);
  return routeRoles.map((role) => {
    // A role with no current profile cannot submit until the owner picks one:
    // the empty prefill stays refillable through `fill`, like every free field.
    // A worker profile the independence rule filters is never prefilled.
    const current = currentRouteProfile(task, role) ?? "";
    const filterNote =
      role === "worker" ? workerRouteFilterNote(facts, current) : null;
    const hostRoute =
      role === "worker" && !filterNote
        ? workerHostRouteView(facts, current)
        : { clearProfile: false, note: null };
    const profileId = filterNote || hostRoute.clearProfile ? "" : current;
    const exhausted =
      role === "reviewer" ? exhaustedReviewer(task, facts.runs) : null;
    const replacementWait =
      task.resolution.ownerStop
        ? ownerStopPendingRefusal(task.resolution.ownerStop)
        : exhausted
          ? exhaustedReviewerRefusal(facts.store, task, exhausted)
          : null;
    const retainedReviewer = exhausted
      ? "The retained reviewer cannot finish. Use run.start reviewer fresh replacing=<run> or add now to replace it."
      : role === "reviewer" && task.resolution.reviewerAgentId
        ? `To replace the retained reviewer directly, use run.start reviewer fresh${task.resolution.currentRunId ? ` replacing=${task.resolution.currentRunId}` : ""}.`
        : null;
    const note = [
      role === "worker" ? workerNote : null,
      filterNote,
      hostRoute.note,
      replacementWait
        ? `Immediate replacement waits. ${replacementWait}`
        : retainedReviewer,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    return !refusal
      ? taskNextVerbSchema.parse({
          verb: "route",
          action: "route",
          available: true,
          args: {
            action: "route",
            taskId: task.id,
            version: task.version,
            role,
            profileId,
          },
          fill: profileId ? ["reason"] : ["profileId", "reason"],
          ...(note ? { note } : {}),
        })
      : taskNextVerbSchema.parse({
          verb: "route",
          action: "route",
          available: false,
          refusal,
        });
  });
}

/**
 * `route` (Spec 050): point a role's next run at a named profile. The control
 * records the profile on `profileRequests` (the same field the existing
 * selection path reads), lifts a matching worker exclusion and, with `now`,
 * stops and replaces the role's live run. The engine performs the profile
 * checks and the live-run bookkeeping.
 */
const route: OwnerVerb = {
  verb: "route",
  action: "route",
  input: verbInput({
    role: z.enum(routeRoles),
    profileId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    thinkingOptionId: z.string().optional(),
    now: z.boolean().optional(),
  }),
  applicable: ({ task }) => {
    const refusal = routeStateRefusal(task);
    return refusal
      ? { available: false, refusal }
      : {
          available: true,
          fill: ["role", "profileId", "reason"],
          args: { taskId: task.id, version: task.version },
        };
  },
  apply: (call, args) =>
    call(
      taskControlInputSchema.parse({
        action: "route",
        ...args,
      }) as TaskControlInput,
    ),
  views: routeViews,
};

/**
 * `complete` (Spec 050): finish a task that has no PR to merge, report-only or
 * no-code, on the owner's call. Only a terminal task, merge intent, a PR and a
 * live run refuse it, and the live run is observed when the control applies;
 * `next` reads the stored activity. No brief heading is proof of scope.
 */
const complete: OwnerVerb = {
  verb: "complete",
  action: "complete",
  input: verbInput({
    reason: z.string().trim().min(1).max(4000),
    artifact: laneDocumentRefSchema.optional(),
  }),
  applicable: (facts) => {
    const { task, runs } = facts;
    if (task.removedAt)
      return { available: false, refusal: REMOVED_TASK_REFUSAL };
    const refusal = completeStateRefusal(task, runs);
    if (refusal) return { available: false, refusal };
    if (task.resolution.ownerStop)
      return {
        available: false,
        refusal: ownerStopPendingRefusal(task.resolution.ownerStop),
      };
    if (
      task.agentActive ||
      runs.some((run) => !run.released && run.active === true)
    )
      return {
        available: false,
        refusal:
          "A live run is active; stop it first (stop), or let it finish, before completing",
      };
    return {
      available: true,
      fill: ["reason"],
      args: { taskId: task.id, version: task.version },
    };
  },
  apply: applyMapped("complete"),
};

/** Whether an owner-routed reviewer shares a model with a prior or current author (Spec 050 waiver). */
export function reviewerSharesAuthorModel(task: Task, model: string): boolean {
  const key = (value: string | null | undefined) =>
    (value ?? "").split("/").at(-1)?.toLowerCase() ?? "";
  const authorModels = new Set(
    [
      ...(task.workerModels ?? []),
      ...(task.workerModel ? [task.workerModel] : []),
      ...(task.profile?.model ? [task.profile.model] : []),
      ...(task.reviewEntry?.authorDeclaration.models ?? []),
    ].map(key),
  );
  return authorModels.has(key(model));
}

/**
 * `proof` (task 405): the explicit owner activation of a brief-named
 * author-side proof execution. It spends one allowance at the exact head, starts a
 * genuine Queue-created executor on the exact published head, and releases
 * nothing: a dispatch or merge hold and pause remain exactly as recorded.
 */
const proof: OwnerVerb = {
  verb: "proof",
  action: "proof",
  input: verbInput({
    reason: z.string().trim().min(1).max(4000),
    relayed: z.boolean().optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }),
  applicable: ({ task, runs, events }) =>
    proofActivationPreview(task, runs, events),
  apply: applyMapped("proof"),
};

const acceptReceipt: OwnerVerb = {
  verb: "accept_receipt",
  action: "accept_receipt",
  input: verbInput({
    reason: z.string().trim().min(1).max(4000),
    relayed: z.boolean().optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }),
  applicable: ({ task }) => {
    const refusal = receiptAcceptanceRefusal(task);
    return refusal
      ? { available: false, refusal }
      : {
          available: true,
          args: { taskId: task.id, version: task.version },
          fill: ["reason"],
          note: "Operator only: accepts this receipt as release evidence and keeps the original reviewer verdict.",
        };
  },
  apply: applyMapped("accept_receipt"),
};

/** `extend_budget` (Spec 058): one authorized increment applies to any exhausted task budget. */
const extendBudget: OwnerVerb = {
  verb: "extend_budget",
  action: "extend_budget",
  input: verbInput({
    reason: z.string().trim().min(1).max(4000),
    relayed: z.boolean().optional(),
    note: z.string().trim().min(1).max(4000).optional(),
  }),
  applicable: ({ task, runs, events, store }) =>
    taskBudget(
      task,
      runs,
      Date.now(),
      events,
      store.canonicalRepository(task.repoPath, task.repository),
      budgetOutageIntervals(store, task.hostId),
    ).exhausted
      ? { available: true, args: { taskId: task.id, version: task.version } }
      : { available: false, refusal: "The task budget is not exhausted" },
  apply: applyMapped("extend_budget"),
};

/**
 * `stop` (round 4, Tom 2026-10-19): halt the task's live work now and park it
 * under an owner dispatch hold. Busy turns are cancelled durably; run state is
 * left for `restart` (continue the same agent), `move` (displace it) or
 * `release` (let dispatch carry on). `role` limits it to one role's runs.
 */
const stop: OwnerVerb = {
  verb: "stop",
  action: "stop",
  input: verbInput({
    role: z.enum(routeRoles).optional(),
    reason: z.string().trim().min(1).max(4000),
  }),
  applicable: (facts) => {
    const { task, runs } = facts;
    const refusal = stopStateRefusal(task);
    if (refusal) return { available: false, refusal };
    if (task.resolution.ownerStop)
      return {
        available: false,
        refusal: ownerStopPendingRefusal(task.resolution.ownerStop),
      };
    const fence = durableRunFence(facts);
    if (fence)
      return {
        available: false,
        refusal: task.resolution.integrationTurn
          ? `${fence}; use turn.release to release its integration turn`
          : fence,
      };
    return {
      available: true,
      fill: ["reason"],
      args: { taskId: task.id, version: task.version },
    };
  },
  apply: (call, args) =>
    call(
      taskControlInputSchema.parse({
        action: "stop",
        ...args,
      }) as TaskControlInput,
    ),
};

/**
 * The recorded disposition's own owner exits (nucleus#1000): `withdraw_cancel`
 * whenever the shared withdrawal rule allows it, and — when the fence is parked
 * in needs_attention — a same-kind re-run that drives the parked step again
 * under the recorded fence. Both read the same recorded facts the applied
 * controls check, so the read view and the verb never disagree. Empty when no
 * active disposition is recorded; nothing else changes its shape.
 */
function dispositionVerbViews(facts: OwnerVerbFacts): TaskNextVerb[] {
  const { task } = facts;
  const disposition = task.disposition;
  if (!disposition || disposition.status === "complete") return [];
  const identity = { taskId: task.id, version: task.version };
  const withdrawal = cancellationWithdrawalRefusal(task);
  const withdraw =
    withdrawal === null
      ? taskNextVerbSchema.parse({
          verb: "withdraw_cancel",
          action: "withdraw_cancel",
          available: true,
          args: { action: "withdraw_cancel", ...identity },
          fill: ["reason"],
        })
      : taskNextVerbSchema.parse({
          verb: "withdraw_cancel",
          action: "withdraw_cancel",
          available: false,
          refusal: withdrawal,
        });
  if (disposition.status !== "needs_attention") return [withdraw];
  const label =
    disposition.kind === "supersede" ? "supersession" : "cancellation";
  const reRun = taskNextVerbSchema.parse({
    verb: disposition.kind,
    action: disposition.kind,
    available: true,
    args: {
      action: disposition.kind,
      ...identity,
      ...(disposition.kind === "supersede"
        ? { replacementTaskId: disposition.replacementTaskId }
        : {}),
    },
    fill: ["reason"],
    note: `Re-runs the parked ${label} step under the recorded fence: ${disposition.attention || disposition.reason}`,
  });
  return [reRun, withdraw];
}

/**
 * The registry. Order is display order for `task.next`: read/assess verbs
 * first, then the controls that resume work, then review and validation.
 */
const setDependencies: OwnerVerb = {
  verb: "set_dependencies",
  action: "set_dependencies",
  input: verbInput({ dependsOn: dependencyIdsSchema }),
  applicable: ({ task }) =>
    task.phase === "queued" &&
    !task.workspaceIntent &&
    !task.workspaceId &&
    !task.agentIntent &&
    !task.agentId &&
    !task.completion &&
    !task.resolution.currentRunId
      ? {
          available: true,
          args: { taskId: task.id, version: task.version },
          fill: ["dependsOn"],
        }
      : {
          available: false,
          refusal: "Dependencies can only change before dispatch begins",
        },
  apply: applyMapped("set_dependencies"),
};

/**
 * `detach` (nucleus#1313, Tom 2026-11-17): "the ability to detach a worker thread
 * from a planner in case the planner needs replacing". It records that this
 * task's presentation has no planner thread, so every host renders the group
 * standalone; it changes no planner, no question route and no lifecycle, and a
 * reparent that names a new planner re-nests the group and clears the record.
 */
const detach: OwnerVerb = {
  verb: "detach",
  action: "detach",
  input: verbInput({ reason: z.string().trim().min(1).max(4000).optional() }),
  applicable: ({ task }) =>
    task.removedAt
      ? { available: false, refusal: REMOVED_TASK_REFUSAL }
      : // nucleus#1323: an operator drag can re-nest a detached group, so the latest
        // presentation parent decides; only a group already standalone is refused.
        (
            task.presentationParent
              ? task.presentationParent.parentThreadId === null
              : task.presentationDetached
          )
        ? {
            available: false,
            refusal: `Presentation is already detached (${task.presentationParent?.by ?? task.presentationDetached?.by}); reparent the task to a planner thread to nest it again`,
          }
        : {
            available: true,
            args: { taskId: task.id, version: task.version },
            fill: ["reason"],
          },
  apply: applyMapped("detach"),
};

export const ownerVerbs: OwnerVerb[] = [
  stop,
  route,
  restart,
  move,
  retryEffect,
  complete,
  proof,
  acceptReceipt,
  extendBudget,
  setDependencies,
  detach,
];

export const ownerVerb = (verb: string): OwnerVerb | undefined =>
  ownerVerbs.find((entry) => entry.verb === verb);

/** One view while a proof-only release GO is open: run-starting verbs refuse, and `proof` names the GO it waits on. */
function proofGoWaitView(view: TaskNextVerb): TaskNextVerb {
  if (PROOF_GO_WAIT_VERBS.has(view.verb))
    return taskNextVerbSchema.parse({
      verb: view.verb,
      action: view.action,
      available: false,
      refusal: PROOF_GO_WAIT_REFUSAL,
    });
  // A busy-refused GO is retried by Queue, so an available `proof` stays available.
  return view.verb === "proof" && !view.available
    ? taskNextVerbSchema.parse({
        verb: view.verb,
        action: view.action,
        available: false,
        refusal: PROOF_GO_WAIT_REFUSAL,
      })
    : view;
}

/** Every registered verb for one task, with prefilled arguments or its refusal. */
export function ownerVerbViews(facts: OwnerVerbFacts): TaskNextVerb[] {
  // Round 4 (Tom, 2026-10-19): verbs apply while Queue is paused; only dispatch
  // waits, so a paused task lists the same verbs as a running one.
  // An active disposition's own exits come first (nucleus#1000): withdraw the
  // cancellation, or re-run the parked step. Every registered verb reads the
  // same fence and refuses on it.
  const dispositionViews = dispositionVerbViews(facts);
  let views = [
    ...dispositionViews,
    ...ownerVerbs
      .filter((verb) => verb.verb !== "accept_receipt" || facts.operatorBoard)
      .flatMap((verb) =>
        facts.task.proofExecutionRetired && verb.verb === "proof"
          ? []
          : verb.views
            ? verb.views(facts)
            : [mappedVerbView(verb, facts)],
      ),
  ];
  if (!facts.task.removedAt) {
    const { task } = facts;
    let moveIndex = 0;
    views = views.map((view) => {
      if (view.verb === "move") {
        const to = moveTargets[moveIndex++];
        return taskNextVerbSchema.parse({
          ...view,
          forceArgs: {
            action: "move",
            taskId: task.id,
            version: task.version,
            to,
            force: true,
          },
          forceFill:
            to === "merge" && !readyReviewAtHead(task)
              ? ["reason", "qualification"]
              : ["reason"],
        });
      }
      return view;
    });
  }
  // effigy#697: while the release GO is open the operator owns the wait. A verb
  // that would start or re-drive a run is unavailable and forces nothing, so the
  // planner ladder offers nothing and `next` says why.
  if (openProofOnlyGo(facts.task, facts.runs, facts.events))
    views = views.map(proofGoWaitView);
  if (facts.task.critical)
    views = views.map((view) => ({
      ...view,
      note: [
        view.note,
        "Critical task: only a planner or operator may use force.",
      ]
        .filter(Boolean)
        .join(" "),
    }));
  const note = continuationCleanupNote(facts);
  // Queue #395: an available continuation gate names the recorded run-bound
  // cleanup before the next run reuses artifacts. Only the note is added: the
  // verb set, its args, availability, the stop and the holds are untouched.
  return note
    ? views.map((verb) =>
        verb.available && continuationVerb(verb)
          ? taskNextVerbSchema.parse({
              ...verb,
              note: verb.note ? `${verb.note} ${note}` : note,
            })
          : verb,
      )
    : views;
}

/** The owner gates that hand a task back to a run which may reuse prior artifacts. */
const continuationVerb = (verb: TaskNextVerb): boolean =>
  verb.verb === "restart" || (verb.verb === "move" && verb.args?.to === "work");

/**
 * Queue #395: the bounded, record-backed cleanup disclosure for an owner
 * continuation. A finished task's restart re-runs a parked closeout step, not
 * artifact work, so it carries none.
 */
function continuationCleanupNote(facts: OwnerVerbFacts): string | null {
  const { task } = facts;
  if (["done", "cancelled"].includes(task.phase)) return null;
  return (
    buildOutputDisclosure(task.resolution?.buildOutputCleanups, {
      workspaceId: task.workspaceId,
      runId: task.completion?.runId ?? task.runId ?? null,
    })?.note ?? null
  );
}

function mappedVerbView(verb: OwnerVerb, facts: OwnerVerbFacts): TaskNextVerb {
  const outcome = verb.applicable(facts);
  return outcome.available
    ? taskNextVerbSchema.parse({
        verb: verb.verb,
        action: verb.action,
        available: true,
        // The mapped action rides in the args, so an owner copies one object
        // straight into `queue.task` and adds only the fields `fill` names.
        args: { action: verb.action, ...outcome.args },
        ...(outcome.fill?.length ? { fill: outcome.fill } : {}),
        ...(outcome.note ? { note: outcome.note } : {}),
      })
    : taskNextVerbSchema.parse({
        verb: verb.verb,
        action: verb.action,
        available: false,
        refusal: outcome.refusal,
      });
}

/**
 * The one `owner_control` audit event for a control applied through the
 * registry: verb, caller, reason, phase before and after, and the derived
 * identities. Record only — it never refuses and never mutates the task.
 * (Spec 058 cutover 5 dropped the old line's `ownerThread` bit with project
 * ownership; recorded lines that carry it stay readable history.)
 */
export function ownerControlEventDetail(
  task: Task,
  input: TaskControlInput,
  phaseBefore: string | null,
  phaseAfter: string | null,
  routeIndependenceWaived = false,
): string {
  const identities = {
    taskId: task.id,
    version: input.version,
    runId: task.runId,
    agentId: task.agentId,
    currentRunId: task.resolution.currentRunId,
    incidentId: task.resolution.incident?.id ?? null,
    incidentStatus: task.resolution.incident?.status ?? null,
    recoveryId: task.resolution.recovery?.id ?? null,
    recoveryStatus: task.resolution.recovery?.status ?? null,
    recoveryRunId: task.resolution.recovery?.runId ?? null,
    holdKinds: Object.keys(holdsOf(task)),
    ...(input.action === "route"
      ? {
          route: {
            role: input.role ?? null,
            profileId: input.profileId ?? null,
            now: input.now ?? false,
            independenceWaived: routeIndependenceWaived,
          },
        }
      : {}),
    ...(input.action === "move"
      ? {
          move: {
            to: input.to ?? null,
            // A qualified owner acceptance and any relayed operator authorization are
            // recorded on the audit line beside the target.
            ...(input.qualification !== undefined
              ? { qualifiedAcceptance: true }
              : {}),
            ...(input.relayed === true ? { relayed: true } : {}),
          },
        }
      : {}),
    ...(input.action === "restart"
      ? { restart: { role: input.role ?? null, fresh: input.fresh ?? false } }
      : {}),
    ...(input.action === "retry_effect"
      ? { effect: input.effect ?? null, discard: input.discard ?? null }
      : {}),
  };
  // The reason is audit prose; the structured identity must stay parseable for
  // every accepted reason, so the prose is bounded by what the line can carry
  // rather than the whole line being sliced into invalid JSON.
  const wire = (reason: string | null) =>
    JSON.stringify({
      verb: input.action,
      caller: input.caller ?? null,
      phaseBefore,
      phaseAfter,
      identities,
      reason,
    });
  let reasonText: string | null = input.reason ?? null;
  let line = wire(reasonText);
  for (
    let attempt = 0;
    line.length > 4000 && reasonText && attempt < 4;
    attempt++
  ) {
    reasonText = reasonText.slice(
      0,
      Math.max(0, reasonText.length - (line.length - 4000) - 16),
    );
    line = wire(reasonText);
  }
  return line.length > 4000 ? wire(null) : line;
}

export function ownerTaskNext(facts: OwnerVerbFacts): TaskNext {
  return assembleOwnerTaskNext(facts, ownerVerbViews);
}

export type { OwnerVerb, RouteRole, RestartRole } from "./owner-shared";
export {
  collectOwnerVerbFacts,
  latestAuthorResult,
  currentReadyPrEvidence,
  neverDispatched,
  retainedWorkerDeliveryRefusal,
  durableRunFence,
  retainedCheckpointRun,
} from "./owner-facts";
export type { OwnerVerbFacts } from "./owner-facts";
export {
  unservedParkedStep,
  restartTakesParkedStep,
  parkedRestart,
  deriveRestartRole,
  isReviewerRelaunchTarget,
  settledReviewerHistory,
  plainHandoverFreshRestart,
  restartShape,
  RestartRefusal,
  workerRestartRefusal,
} from "./owner-restart";
export { unreleasedLaunchFence } from "./owner-facts";
export type { RestartShape } from "./owner-restart";
export {
  ownerEffectKey,
  ownerEffectIdentity,
  ownerEffectOccurrence,
  ownerPendingEffects,
  splitOwnerEffectKey,
} from "./owner-effects";
export type { OwnerEffect } from "./owner-effects";
export { qualifiedAcceptanceEligibility } from "./owner-move";
