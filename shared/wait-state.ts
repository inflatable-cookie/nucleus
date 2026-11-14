import { z } from "zod";

/**
 * Spec 043 (a): the explicit wait a waiting task is in, with an owner and a next
 * action.
 *
 * The board used to show a generic slot reason for a capacity wait and looked
 * like recovery for every other wait. This module names each declared wait once.
 * This projection changes no scheduling decision. Scheduling reads a separate
 * retained-wait record where Spec 043 defines one.
 *
 * Only an explicit declaration sets `needs_source_rights`; it is never inferred
 * from reason text. Operator decisions, dependency status, refused slot requests
 * and a merge hold that is otherwise ready to merge are supplied as current
 * facts by the read boundary. Stale task reason text cannot keep a task in one
 * of those waits.
 */
export const waitStates = ["waiting_capacity", "waiting_prerequisite", "needs_operator_input", "needs_source_rights", "merge_hold"] as const;
export type WaitState = (typeof waitStates)[number];
export const waitStateSchema = z.enum(waitStates);

/** Board labels (Spec 043 (a)): what the Pipeline shows for each state. */
export const waitStateLabels: Record<WaitState, string> = {
  waiting_capacity: "Waiting for capacity",
  waiting_prerequisite: "Waiting for prerequisite",
  needs_operator_input: "Needs operator input",
  needs_source_rights: "Needs source rights",
  merge_hold: "Merge hold",
};

/** The reason `Store.dependencyWait` writes for an unfinished prerequisite. */
export const PREREQUISITE_WAIT_PREFIX = "Waiting for prerequisites:";
/** The reason `Resolution.slotAdmissionReason` writes while a task waits for a task slot. */
export const CAPACITY_WAIT_PREFIX = "Waiting for a project slot…";
export const PROJECT_IN_FLIGHT_WAIT_PREFIX = "Waiting: ";
/** `Resolution.slotAdmissionReason` when in-flight requests rank ahead of this wait. */
export const inFlightSlotWaitReason = (count: number, tasks: readonly string[] = []) =>
  `${CAPACITY_WAIT_PREFIX} waiting behind ${count} in-flight${tasks.length ? `: ${tasks.join(", ")}` : ""}`;
/** The reason a project-validation host run writes while it waits in the QA queue. */
export const QA_CAPACITY_WAIT_PREFIX = "Waiting for QA capacity (position ";
export const qaCapacityWaitReason = (position: number) => `${QA_CAPACITY_WAIT_PREFIX}${position})`;
export const RETAINED_PREREQUISITE_WAIT_ACTION = "Wait for the listed prerequisites; Nucleus will notify the owner. Explicitly revise or retry a changes-requested task after the notice";
export const RETAINED_PREREQUISITE_FIX_ACTION = "Clear or replace this wait with set_prerequisite_wait";

/**
 * Every current waiting reason Queue writes that is one of the five declared
 * states, with the one state it maps to and the owner and next action that
 * reason actually implies. A reason matches by its exact Queue-owned prefix, so
 * free text can never invent a wait state, and the owner is derived from the
 * matched reason rather than from the state alone: a task-slot wait clears by
 * freeing a slot, a project-validation wait sits in the separate machine-wide QA
 * scheduler and starts automatically when admitted, and a prerequisite that was
 * removed before completion, is missing, or is terminal `cancelled` can never
 * finish, so the operator corrects the dependency list instead of waiting. A
 * Spec 043 (c) prerequisite that merged with its declared goal unmet joins them:
 * it is done and still never satisfies a dependent.
 *
 * Operational reasons not listed here — a transient provider continuation, a
 * repository integration-turn wait, a validation already running, a catalog
 * fault — are progress detail rather than a declared wait, and map to no state.
 */
export interface WaitReasonEntry {
  prefix: string;
  state: WaitState;
  owner: string;
  nextAction: string;
  /** A further test on the full reason; absent means the prefix alone matches. */
  matches?: (reason: string) => boolean;
}
/** `Store.dependencyWait` writes this status after a present prerequisite's id. */
export const PREREQUISITE_REMOVED_STATUS = "removed before completion";
/** `Store.dependencyWait` writes this status after a present prerequisite's id. */
export const PREREQUISITE_CANCELLED_STATUS = "cancelled";
/** `Store.dependencyWait` writes this status when the referenced prerequisite task is missing. */
export const PREREQUISITE_MISSING_STATUS = "missing";
/**
 * Spec 043 (c) goal gate: `Store.dependencyWait` writes this status when a
 * prerequisite merged with a declared goal unmet. Only `done` satisfies a
 * dependency, and a done task with an unmet goal is not that, so this wait can
 * never clear by itself and the operator re-points the dependency.
 */
export const PREREQUISITE_GOAL_UNMET_STATUS = "goal unmet";
/** A prerequisite task id, the only token `Store.dependencyWait` writes before a missing status. */
const PREREQUISITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The generated status of one entry of a `dependencyWait` reason. A present
 * prerequisite is `${title} (${id}): ${status}`, so the status is the text after
 * the entry's last `): `; a missing one is the id alone, `${id}: missing`. The
 * title is free-form, so the status is never read from anywhere else.
 */
function prerequisiteEntryCannotComplete(entry: string): boolean {
  const fact = prerequisiteEntryFacts(entry);
  return Boolean(fact.id) && (fact.status === PREREQUISITE_REMOVED_STATUS || fact.status === PREREQUISITE_CANCELLED_STATUS
    || fact.status === PREREQUISITE_GOAL_UNMET_STATUS || fact.status === PREREQUISITE_MISSING_STATUS);
}
/** Facts in the generated prerequisite reason, decoded once for board and wait views. */
function prerequisiteEntryFacts(entry: string): { id: string | null; title: string; status: string } {
  const afterId = entry.lastIndexOf("): ");
  if (afterId >= 0) {
    const open = entry.lastIndexOf("(", afterId);
    const id = open >= 0 ? entry.slice(open + 1, afterId) : "";
    if (PREREQUISITE_ID.test(id)) return { id, title: entry.slice(0, open).trim(), status: entry.slice(afterId + 3).trim() };
  }
  const afterToken = entry.lastIndexOf(": ");
  if (afterToken >= 0) {
    const id = entry.slice(0, afterToken).trim();
    if (PREREQUISITE_ID.test(id)) return { id, title: "Prerequisite", status: entry.slice(afterToken + 2).trim() };
  }
  return { id: null, title: entry, status: "" };
}
export function prerequisiteReasonEntries(reason: string): Array<{ id: string | null; title: string; status: string }> {
  const body = reason.startsWith(PREREQUISITE_WAIT_PREFIX) ? reason.slice(PREREQUISITE_WAIT_PREFIX.length) : reason;
  return body.split("; ").map(value => value.trim()).filter(Boolean).map(prerequisiteEntryFacts);
}
/**
 * True when a prerequisite reason names a dependency that can never reach
 * `done`: it was removed before completion, its referenced task is missing, or it
 * is terminal `cancelled`. Only `done` satisfies a prerequisite, so waiting for
 * completion cannot clear any of those waits; the operator corrects the
 * dependency list with the existing pre-dispatch control (`set_dependencies`)
 * instead. The status is read only from the generated entry suffix, so a title
 * that happens to contain one of these words stays an ordinary wait.
 */
export function prerequisiteCannotComplete(reason: string): boolean {
  const body = reason.startsWith(PREREQUISITE_WAIT_PREFIX) ? reason.slice(PREREQUISITE_WAIT_PREFIX.length) : reason;
  return body.split("; ").some(prerequisiteEntryCannotComplete);
}
/** The operator's pre-dispatch dependency-list correction, shared by the table and its tests. */
export const PREREQUISITE_DEPENDENCY_ACTION = "Correct the dependency list before dispatch (set_dependencies): drop the missing, removed, cancelled or goal-unmet prerequisite";
/** The one durable bound on a wait's `owner` line, shared by the projection and its declarations. */
export const WAIT_OWNER_LIMIT = 240;
/**
 * Spec 043 (a): the board and detail owner of a `waiting_prerequisite` wait is one
 * bounded line. A task may legitimately declare a large prerequisite fan-in, and
 * the unfinished-id list then overruns the owner bound and fails every board,
 * detail and health projection. Keep whole prerequisite identities in declaration
 * order until the bound, then name the remainder as a count. Nothing is dropped
 * from the task itself: `dependsOn` and the dependency-wait reason keep every
 * identity, and dispatch still reads the full list.
 */
export function boundedPrerequisiteOwner(owner: string | null | undefined): string | null {
  const text = (owner ?? "").trim();
  if (!text || text.length <= WAIT_OWNER_LIMIT) return text || null;
  const entries = text.split(",").map(entry => entry.trim()).filter(Boolean);
  for (let keep = entries.length - 1; keep > 0; keep -= 1) {
    const remainder = entries.length - keep;
    const candidate = `${entries.slice(0, keep).join(", ")}, +${remainder} more`;
    if (candidate.length <= WAIT_OWNER_LIMIT) return candidate;
  }
  // No whole entry fits the bound (never a UUID): the count is all that fits.
  return `${entries.length} prerequisite${entries.length === 1 ? "" : "s"} (see task detail)`;
}
export const waitReasonStates: ReadonlyArray<WaitReasonEntry> = [
  { prefix: PROJECT_IN_FLIGHT_WAIT_PREFIX, state: "waiting_capacity", owner: "operator",
    nextAction: "Wait for in-flight tasks to finish; Nucleus starts work when the project is under its cap",
    matches: reason => /^Waiting: \d+ of \d+ tasks in flight for this project$/.test(reason) },
  { prefix: CAPACITY_WAIT_PREFIX, state: "waiting_capacity", owner: "operator",
    nextAction: "Free a task slot or raise the limit; Nucleus dispatches when capacity allows" },
  { prefix: QA_CAPACITY_WAIT_PREFIX, state: "waiting_capacity", owner: "Queue QA scheduler",
    nextAction: "Waits for machine-wide QA capacity; it starts automatically when admitted" },
  // A prerequisite that can still finish: Queue resumes this task automatically.
  { prefix: PREREQUISITE_WAIT_PREFIX, state: "waiting_prerequisite", owner: "Queue",
    nextAction: "Wait for the prerequisite to finish; Nucleus dispatches this task automatically",
    matches: reason => !prerequisiteCannotComplete(reason) },
  // A prerequisite that can never finish: the operator corrects the dependency list.
  { prefix: PREREQUISITE_WAIT_PREFIX, state: "waiting_prerequisite", owner: "operator",
    nextAction: PREREQUISITE_DEPENDENCY_ACTION,
    matches: prerequisiteCannotComplete },
];

/** The one current waiting reason entry a reason matches, or null for operational detail. */
export function waitReasonFor(reason: string): WaitReasonEntry | null {
  const matches = waitReasonStates.filter(entry => reason.startsWith(entry.prefix) && (!entry.matches || entry.matches(reason)));
  return matches.length ? matches[0] : null;
}

/** The one state a current waiting reason names, or null for operational detail. */
export function waitStateForReason(reason: string): WaitState | null {
  // Only the separate project-validation scheduler uses its own current wait
  // reason as the fact. Task-slot and prerequisite waits require read-boundary
  // evidence and must not be revived by stale task.reason text.
  return reason.startsWith(QA_CAPACITY_WAIT_PREFIX) ? waitReasonFor(reason)?.state ?? null : null;
}

/**
 * The Spec 032 decision-link invariant: `needs_operator_input` must name the
 * decision that carries its question, and no other wait state may carry a
 * decision id. Enforced on both the explicit declaration and the derived view,
 * so neither can express a wait with a missing or stray decision.
 */
type WaitDecisionLink = { state: WaitState; decisionId?: string | null };
function decisionLinkIssues(value: WaitDecisionLink): Array<{ code: "custom"; message: string; path: string[] }> {
  const issues: Array<{ code: "custom"; message: string; path: string[] }> = [];
  if (value.state === "needs_operator_input" && !value.decisionId)
    issues.push({ code: "custom", message: "needs_operator_input requires the Spec 032 decisionId", path: ["decisionId"] });
  if (value.state !== "needs_operator_input" && value.decisionId)
    issues.push({ code: "custom", message: `${value.state} must not carry a decisionId`, path: ["decisionId"] });
  return issues;
}

/**
 * An explicit, caller-owned declaration of a wait. It is validated here and wins
 * over the derived reading, so an explicit declaration is never confused with
 * free text.
 */
export const waitDeclarationSchema = z.object({
  state: waitStateSchema,
  owner: z.string().min(1).max(WAIT_OWNER_LIMIT),
  nextAction: z.string().min(1).max(600),
  decisionId: z.string().min(1).max(160).nullable().default(null),
}).strict().superRefine((value, context) => { for (const issue of decisionLinkIssues(value)) context.addIssue(issue); });
export type WaitDeclaration = z.infer<typeof waitDeclarationSchema>;

/** The derived wait view: one state, its owner and the next action that clears it. */
export const waitStateViewSchema = z.object({
  state: waitStateSchema,
  owner: z.string().min(1).max(WAIT_OWNER_LIMIT),
  nextAction: z.string().min(1).max(600),
  reason: z.string().trim().min(1).max(4000).optional(),
  /** Present exactly for `needs_operator_input`: the Spec 032 decision to answer. */
  decisionId: z.string().min(1).max(160).optional(),
}).strict().superRefine((value, context) => { for (const issue of decisionLinkIssues(value)) context.addIssue(issue); });
export type WaitStateView = z.infer<typeof waitStateViewSchema>;

/** The task facts the derivation reads; `holdKind` is Spec 040's derived hold kind. */
export interface WaitStateTask {
  phase: string;
  reason: string;
  holdKind: "dispatch" | "merge" | null;
  holdOwner: string | null;
  originAgentId: string | null;
  /** Present when a merge fence exists; defaults to `holdKind === "merge"`. */
  mergeHeld?: boolean;
}

export interface WaitStateContext {
  /** The open Spec 032 decision linked to the task, when one exists. */
  decisionId?: string | null;
  /** Current Store.dependencyWait result for this task's active prerequisite list. */
  dependencyWait?: string | null;
  /** IDs of the prerequisites that are still unfinished. */
  prerequisiteOwner?: string | null;
  /** Operator reason for a retained-task prerequisite wait. */
  prerequisiteReason?: string | null;
  /** Current Resolution.slotAdmissionReason result, never copied from task.reason. */
  slotAdmissionReason?: string | null;
  /** An explicit stage wait used only after higher-priority current facts are checked. */
  declaration?: WaitDeclaration | null;
}

/**
 * The one wait a task is in, or null when it is not in a declared wait. Current
 * facts take precedence in the order used by Spec 043 (a): open decision,
 * unfinished prerequisites, current slot refusal, then explicit declaration and
 * QA scheduler state. A merge hold is a secondary flag until the task is
 * otherwise ready to merge (verifying or merging). A stale capacity or
 * prerequisite reason is never sufficient. A dispatch hold is a Spec 040 badge,
 * not a wait.
 */
export function deriveWaitState(task: WaitStateTask, context: WaitStateContext = {}): WaitStateView | null {
  // The declaration is revalidated here, not merely forwarded: an invalid shape
  // (needs_operator_input without its decision, or an id on another state) is a
  // caller error and must never reach the board.
  const declaration = context.declaration ? waitDeclarationSchema.parse(context.declaration) : null;
  if (context.decisionId) return { state: "needs_operator_input", owner: "operator", nextAction: `Answer decision ${context.decisionId}`, decisionId: context.decisionId };
  const dependency = context.dependencyWait ? waitReasonFor(context.dependencyWait) : null;
  if (dependency?.state === "waiting_prerequisite") {
    const cannotComplete = prerequisiteCannotComplete(context.dependencyWait!);
    const retained = Boolean(context.prerequisiteReason);
    return {
      state: "waiting_prerequisite",
      owner: cannotComplete ? "operator" : boundedPrerequisiteOwner(context.prerequisiteOwner) || dependency.owner,
      nextAction: cannotComplete
        ? retained ? RETAINED_PREREQUISITE_FIX_ACTION : PREREQUISITE_DEPENDENCY_ACTION
        : retained ? RETAINED_PREREQUISITE_WAIT_ACTION : dependency.nextAction,
      ...(retained ? { reason: context.prerequisiteReason! } : {}),
    };
  }
  const capacity = context.slotAdmissionReason ? waitReasonFor(context.slotAdmissionReason) : null;
  if (capacity?.state === "waiting_capacity") return { state: capacity.state, owner: capacity.owner, nextAction: capacity.nextAction };
  if (declaration) return waitStateViewSchema.parse(declaration.decisionId
    ? { state: declaration.state, owner: declaration.owner, nextAction: declaration.nextAction, decisionId: declaration.decisionId }
    : { state: declaration.state, owner: declaration.owner, nextAction: declaration.nextAction });
  // Project-validation QA waits are owned by their separate machine-wide
  // scheduler. Task-slot capacity is read only from the current admission check.
  const schedulerWait = task.reason.startsWith(QA_CAPACITY_WAIT_PREFIX) ? waitReasonFor(task.reason) : null;
  if (schedulerWait) return { state: schedulerWait.state, owner: schedulerWait.owner, nextAction: schedulerWait.nextAction };
  const mergeHeld = task.mergeHeld ?? task.holdKind === "merge";
  if (mergeHeld && (task.phase === "verifying" || task.phase === "merging"))
    return { state: "merge_hold", owner: task.holdOwner ?? task.originAgentId ?? "operator", nextAction: "Release the hold, or keep it with a reason" };
  return null;
}
