import { isOperatorBoardOrT3 } from "../../shared/operator-identity";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { taskOwner, type Profile, type Task } from "../../shared/contracts";
import { automaticReachable } from "../../shared/pool";
import { climbedTier, requestedTier } from "../../shared/demand";
import type { Decisions } from "../planning/decisions";
import type { Store } from "../store/store";

const KEEP_AUTOMATIC = "Decline: keep automatic selection";

function withdrawOpen(decisions: Decisions, decisionId: string, reason: string): boolean {
  try {
    const decision = decisions.get({ id: decisionId });
    if (decision.status !== "open") return true;
    decisions.withdraw({ id: decision.id, version: decision.version, reason, withdrawnBy: "queue" });
    return true;
  } catch { return false; }
}

/** Resolve the unavailable-profile question for a required worker selection. */
export function reconcileUnavailablePreference(
  store: Store,
  decisions: Decisions,
  task: Task,
  profiles: readonly Profile[],
  workerCatalogPending = false,
): Task {
  const finished = task.phase === "done" || task.phase === "cancelled";
  const request = task.profileRequests?.worker;
  const profileId = request?.required
    ? request.profileId
    : !request && task.requirePreferred
      ? task.preferredProfileId
      : "";
  const thinking = request?.required
    ? request.thinkingOptionId || task.thinkingOptionId
    : !request && task.requirePreferred
      ? task.thinkingOptionId
      : "";
  const events = store.eventsAll(task.id);
  // Reconcile all prior questions before consulting the current preference: a
  // changed or cleared request must not leave an answerable orphan behind.
  for (const event of events.filter(
    (item) => item.kind === "routing_unavailable_requested",
  )) {
    const split = event.detail.indexOf(": ");
    if (split < 0) continue;
    const requested = event.detail.slice(0, split);
    if (
      requested === profileId &&
      !finished &&
      !task.agentIntent &&
      !task.agentId
    )
      continue;
    if (
      events.some(
        (item) =>
          item.id > event.id &&
          item.kind === "routing_unavailable_resolved" &&
          item.detail.startsWith(`${requested}: `),
      )
    )
      continue;
    try {
      const record = JSON.parse(event.detail.slice(split + 2)) as {
        decisionId: string;
      };
      if (
        withdrawOpen(
          decisions,
          record.decisionId,
          "The required routing preference changed or the task advanced",
        )
      )
        store.event(
          task.id,
          "routing_unavailable_resolved",
          `${requested}: routing preference changed`,
        );
      else
        store.event(
          task.id,
          "routing_unavailable_withdraw_failed",
          JSON.stringify({
            decisionId: record.decisionId,
            reason:
              "The required routing preference changed or the task advanced",
          }),
        );
    } catch {
      /* Preserve unreadable evidence rather than guessing its identity. */
    }
  }
  if (!profileId) return task;
  const entry = store.pool().find((item) => item.profileId === profileId);
  const profile = profiles.find((item) => item.id === profileId);
  const needsRequest = !request && entry && !automaticReachable(
    entry, store.usageLevel(), requestedTier(task.complexity), climbedTier(task),
  );
  const availableOnAnyHost = Boolean(
    entry?.enabled &&
      profile?.available &&
      (!thinking || profile.supportedThinking.includes(thinking)),
  );
  const last = store
    .eventsAll(task.id)
    .findLast(
      (event) =>
        [
          "routing_unavailable_requested",
          "routing_unavailable_resolved",
        ].includes(event.kind) && event.detail.startsWith(`${profileId}: `),
    );
  const prior =
    last?.kind === "routing_unavailable_requested" ? last : undefined;
  if (availableOnAnyHost || finished || task.agentIntent || task.agentId) {
    if (prior) {
      try {
        const record = JSON.parse(prior.detail.slice(profileId.length + 2)) as {
          decisionId: string;
        };
        const reason = "The required routing wait no longer applies";
        if (withdrawOpen(decisions, record.decisionId, reason))
          store.event(task.id, "routing_unavailable_resolved", `${profileId}: routing wait ended`);
        else
          store.event(task.id, "routing_unavailable_withdraw_failed", JSON.stringify({ decisionId: record.decisionId, reason }));
      } catch {
        /* Keep unreadable evidence rather than guessing its identity. */
      }
    }
    return task;
  }
  if (needsRequest) return task;
  if (entry?.enabled && !availableOnAnyHost && workerCatalogPending && !prior)
    return task;
  if (prior) {
    let record: { decisionId: string; choices: Record<string, string> };
    try {
      record = JSON.parse(prior.detail.slice(profileId.length + 2));
    } catch {
      return task;
    }
    let decision;
    try {
      decision = decisions.get({ id: record.decisionId });
    } catch {
      return task;
    }
    if (
      decision.status !== "answered" ||
      !decision.answer ||
      decision.answer.relayed ||
      !isOperatorBoardOrT3(decision.answer.answeredBy)
    )
      return task;
    const selected = record.choices[decision.answer.text.trim()];
    if (selected)
      return store.update(
        task.id,
        {
          profileRequests: {
            ...task.profileRequests,
            worker: {
              profileId: selected,
              required: true,
              reason: "Operator selected an available worker profile",
            },
          },
        },
        "routing_unavailable_resolved",
        `${profileId}: selected ${selected}`,
      );
    if (decision.answer.text.trim() === KEEP_AUTOMATIC)
      return store.update(
        task.id,
        {
          requirePreferred: false,
          preferredProfileId: "",
          profileRequests: { ...task.profileRequests, worker: undefined },
        },
        "routing_unavailable_resolved",
        `${profileId}: automatic selection`,
      );
    return task;
  }
  const choices: Record<string, string> = {};
  for (const candidate of store.pool()) {
    const available = profiles.find(
      (item) => item.id === candidate.profileId && item.available,
    );
    if (candidate.enabled && available && candidate.profileId !== profileId)
      choices[`Use ${available.name}`.slice(0, 200)] = candidate.profileId;
  }
  const origin = normalizeRepositoryOrigin(task.repository ?? "");
  const decision = decisions.add({
    askedBy: taskOwner(task),
    project: origin ? { origin, path: task.repoPath } : null,
    tasks: [task.id],
    question: `Required worker profile ${profileId} is missing, disabled or unavailable. Which route should this task use?`,
    options: [KEEP_AUTOMATIC, ...Object.keys(choices).slice(0, 13)],
  });
  store.event(
    task.id,
    "routing_unavailable_requested",
    `${profileId}: ${JSON.stringify({ decisionId: decision.id, choices })}`,
  );
  return task;
}
