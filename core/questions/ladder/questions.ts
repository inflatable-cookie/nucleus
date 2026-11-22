import type {
  Completion,
  ExplicitCommand,
  Task,
  TaskNextVerb,
} from "../../../shared/contracts";
import { taskContextLines } from "../question-delegation";

/**
 * What the ladder asks, and the window it asks in. One owner for the consult and
 * escalation questions, the choices they offer and the instruction an answer
 * becomes, so a delegate reads the same words every route sends.
 */

/** How long one reviewer consult may take before it falls through to the planner. */
export const REVIEWER_CONSULT_TIMEOUT_MS = 5 * 60_000;

/** The concrete options a blocker or revision-cap escalation offers the delegate. */
export const PLANNER_ESCALATION_CHOICES = [
  "Return to the worker with a new approach",
  "Stop and keep the work",
  "Wait for a task (put its reference in Reason)",
  "Wait until a time (put an ISO timestamp in Reason)",
  "Wait for an operator decision (put its ID in Reason)",
] as const;
type PlannerEscalationChoice = (typeof PLANNER_ESCALATION_CHOICES)[number];

/** A proof-only task has no worker, so escalation never offers a worker return. */
export function plannerEscalationChoicesFor(task: {
  entrypoint?: Task["entrypoint"];
}): readonly PlannerEscalationChoice[] {
  if (task.entrypoint === "proof")
    return PLANNER_ESCALATION_CHOICES.filter(
      (choice) => choice !== "Return to the worker with a new approach",
    );
  return PLANNER_ESCALATION_CHOICES;
}

/** A copy of a safe ordinary owner-verb offer, or an explicit Spec 067 command option. */
export type EscalationVerbChoice = {
  label: string;
  verb: string;
  args: Record<string, unknown>;
  command?: ExplicitCommand;
};

export function escalationVerbChoices(
  views: readonly TaskNextVerb[],
): EscalationVerbChoice[] {
  return views.flatMap((view) => {
    if (
      !view.available ||
      !view.args ||
      !["retry_effect", "move", "restart", "route"].includes(view.verb)
    )
      return [];
    // The reason supplies the only required free text. Work has its own direction
    // choice. Discard, qualification and profile sign-off never come from a reply.
    if (
      (view.fill ?? []).some((field) => field !== "reason") ||
      (view.verb === "move" &&
        ["work", "closeout"].includes(String(view.args.to)))
    )
      return [];
    const {
      taskId: _taskId,
      version: _version,
      action: _action,
      summary,
      ...args
    } = view.args;
    const target =
      view.verb === "retry_effect"
        ? `Retry ${String(args.effect)}: ${String(summary ?? "observe and retry the recorded effect")}`
        : view.verb === "move"
          ? `Move to ${String(args.to)}`
          : view.verb === "restart"
            ? `Restart ${String(args.role ?? "the stopped step")}${args.fresh ? " with a fresh agent" : ""}`
            : `Route ${String(args.role)} to ${String(args.profileId)}`;
    const description = view.note
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
      .trim();
    return [
      {
        label: description ? `${target}: ${description}` : target,
        verb: view.verb,
        args,
      },
    ];
  });
}

/** The question a blocked report asks the retained reviewer: advice, not a verdict. */
export function reviewerConsultQuestion(
  task: Pick<Task, "title">,
  completion: Pick<Completion, "status" | "summary" | "head">,
): string {
  const summary = completion.summary.trim().replace(/\s+/g, " ").slice(0, 3000);
  return `Second opinion (consult, not a review round): the worker for "${task.title}" reported ${completion.status} and cannot proceed. Its report: ${summary} ${completion.head ? `Its head is ${completion.head}. ` : ""}As the retained reviewer, give your second opinion: what the worker should try within the approved outcome to get unstuck, or whether the cause is genuinely outside the task. Do not review the change and do not publish anything; Queue returns your advice to the same worker.`;
}

/** The prompt a mid-turn reviewer-target `nucleus_ask` delivers to the retained reviewer. */
export const reviewerAskPrompt = (
  question: string,
  title: string,
  context: readonly string[] = [],
): string =>
  `The worker for "${title}" asks you, as its retained reviewer, for a second opinion — a consult, not a review round. If you can name a safe action within the approved outcome, recommend it directly; the worker owns that decision and any bounded diagnostic. Answer with your advice; Nucleus returns it to the worker in turn. Only when this needs a planning ruling, use question.answer with the one-line answer text Decision: planner — <reason>. Do not start a review round or give merge approval.\n\nQuestion: ${[question, ...taskContextLines(context)].join("\n")}`;

/** The escalation question the delegate answers: the task, the blocker, the reviewer's view, the options. */
export function plannerEscalationQuestion(
  task: Pick<Task, "title"> & Partial<Pick<Task, "entrypoint" | "proofOnly">>,
  completion: Pick<Completion, "status" | "summary">,
  advice: string | null,
): string {
  const summary = completion.summary.trim().replace(/\s+/g, " ").slice(0, 3000);
  const reviewer = advice
    ? ` The retained reviewer was already consulted; its advice was: ${advice.trim().replace(/\s+/g, " ").slice(0, 2000)}`
    : " The retained reviewer was not consulted for this cause.";
  const proofOnly = task.entrypoint === "proof";
  const who = proofOnly ? "Its receipt review reported" : "Its worker reported";
  const follow = proofOnly
    ? "You may also answer directly with the direction Queue should follow, including a receipt review."
    : "You may also answer directly with the direction the worker should follow.";
  return `The responsible task "${task.title}" is stuck. ${who} ${completion.status}: ${summary}.${reviewer} Choose how it proceeds: ${plannerEscalationChoicesFor(task).join("; ")}. ${follow}`;
}

/** The revision-cap escalation question: the planner decides the next approach. */
export function revisionCapEscalationQuestion(
  task: Pick<Task, "title">,
  revisionRuns: number,
  findings: string,
): string {
  return `The responsible task "${task.title}" exhausted its revision budget after ${revisionRuns} review rounds without convergence. The latest review findings: ${findings.trim().replace(/\s+/g, " ").slice(0, 3000)} Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join("; ")}. You may also answer directly with the direction the worker should follow.`;
}

/** The reviewer-checkpoint stop's escalation question: the planner decides the next approach. */
export function reviewContinuationEscalationQuestion(
  task: Pick<Task, "title">,
  state: "exhausted" | "closed",
): string {
  const stop =
    state === "exhausted"
      ? "spent its checkpoint budget and stopped"
      : "was observed closed with its checkpoint preserved, so the same-agent continuation is impossible";
  return `The responsible task "${task.title}"'s retained reviewer ${stop}. A deliberate fresh reviewer replacement at the same head (restart role=reviewer fresh) is the ordinary exit. Choose how it proceeds: ${PLANNER_ESCALATION_CHOICES.join("; ")}. You may also answer directly with the direction Queue should follow.`;
}

/** The instruction a consult advice becomes for the same retained worker. */
export const consultContinuationInstruction = (
  id: string,
  advice: string,
): string =>
  `Your blocked report went to the retained reviewer as a second opinion (consult ${id}). The reviewer's advice: ${advice.trim().slice(0, 6000)} Continue the task with this advice under the ownership rule; report blocked again only for an external cause, naming it.`;

/** The instruction a delegated escalation answer becomes for the same retained worker. */
export const escalationContinuationInstruction = (
  id: string,
  who: string,
  answer: string,
): string =>
  `The planner ladder answered your blocker escalation ${id} (${who}). Direction: ${answer.trim().slice(0, 6000)} Continue the task under the ownership rule with this direction; report blocked again only for an external cause, naming it.`;
