import { z } from "zod";
import { digest, type Store } from "../store/store";
import type { Run, Task } from "../../shared/contracts";
import { liveResumeRunSupersedes, recordSupersededRunRefusal, supersededByPendingResume, supersededResumeRefusal } from "../recovery/superseded-resume";
import { ownerArmedRetainedWorker } from "../recovery/task-reasons";
import {
  isDelegableQuestionKind,
  type OperatorQuestionKind,
} from "./operator-question";
import { normalizeAskTarget, verbTargetSchema } from "../../shared/agent-verbs.mjs";

/**
 * Spec 058 (task 550; task 562 pending+resume): `nucleus_ask`, the Queue
 * question tool on every provider's MCP binding.
 *
 * A Queue-launched worker or reviewer calls it in-turn with a question and, for
 * board decisions, a headline, two or three choices with consequences, the
 * recommended label and supporting details. Queue records the durable ask intent first,
 * so delivery to Queue is never in doubt once the tool returns anything, then
 * routes worker questions to the retained reviewer first. Only a reviewer-requested
 * planning ruling, or no retained reviewer, opens the planner/decider rung.
 * Operator-only kinds and reviewer asks retain planner classification before
 * any operator decision on the board and task composer pill. The call
 * waits in-turn for the answer, bounded, returning it with who answered. When no
 * answer arrives within the wait the tool returns pending with the question id
 * and who it sits with, and Queue resumes the asking agent with the answer when
 * it arrives. An ask is identified by its content, so an identical retry or a
 * re-ask after a lost response joins the same question and returns its recorded
 * answer; unknown delivery is never re-asked blindly. Queue-raised questions on
 * providers without a native question surface join the same path by their content
 * digest.
 */

/** Every Queue question kind, plus `process` for a worker's or reviewer's own question. */
export const AGENT_ASK_KINDS = [
  "proof_acceptance",
  "budget",
  "review",
  "scope",
  "release",
  "process",
] as const;
export type AgentAskKind = (typeof AGENT_ASK_KINDS)[number];

/** An ask without a hint is ordinary process: delegated, never operator-only. */
export const DEFAULT_AGENT_ASK_KIND: AgentAskKind = "process";

export const isOperatorOnlyAsk = (kind: AgentAskKind): boolean =>
  !isDelegableQuestionKind(kind);

/**
 * Refuse an ask that carries no real question. Empty text and the literal
 * placeholder token are probes, not questions; they never route. Short real
 * questions ("Ship?", "Merge?") stay valid.
 */
export function askQuestionRefusal(question: string): string | null {
  const text = question.trim();
  if (!text) return "nucleus_ask requires a real question; empty text is refused";
  if (/^placeholder$/i.test(text)) return "nucleus_ask requires a real question; placeholder text is refused";
  return null;
}

/**
 * The in-turn wait: about 120 seconds, then the tool returns pending and relies
 * on resume. The planner window is about ten minutes and the decider starts
 * after it, so an in-turn wait can never cover delegation; routing continues in
 * the background after the pending return and Queue resumes the agent with the
 * recorded answer, so a later re-ask with the same content only collects it.
 */
export const AGENT_ASK_WAIT_MS = 120_000;

/** How often the bounded wait re-reads the durable answer. */
export const AGENT_ASK_POLL_MS = 1_500;

const agentAskChoiceSchema = z.object({ label: z.string().trim().min(1).max(120), consequence: z.string().trim().max(240).regex(/^[^\r\n]*$/) }).strict();
export const agentAskSchema = z
  .object({
    eventId: z.string().regex(/^[a-f0-9]{64}$/),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    question: z.string().trim().min(1).max(4000),
    headline: z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),
    choices: z.array(z.union([z.string().trim().min(1).max(400), agentAskChoiceSchema])).max(10).optional(),
    recommended: z.string().trim().min(1).max(120).optional(),
    details: z.string().max(48000).nullable().optional(),
    kind: z.enum(AGENT_ASK_KINDS).optional(),
    /**
     * A worker's second opinion reaches its retained reviewer mid-turn; the answer
     * records who answered. The target hint cannot bypass that authenticated route.
     * Reviewer asks and operator-only kinds keep planner classification. With no
     * retained reviewer the ordinary planner route answers the question.
     */
    target: z.enum(['planner', 'reviewer']).optional(),
    /** The `ask` recipient (shared/agent-verbs): a keyword, a project or another task's planner. */
    to: verbTargetSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try { normalizeAskTarget(value.to, value.target); }
    catch (error) { ctx.addIssue({ code: "custom", path: ["to"], message: error instanceof Error ? error.message : String(error) }); }
    const rawChoices = value.choices ?? [];
    const structured = rawChoices.filter((choice): choice is z.infer<typeof agentAskChoiceSchema> => typeof choice !== "string");
    if (structured.length && (structured.length !== rawChoices.length || rawChoices.length < 2 || rawChoices.length > 3))
      ctx.addIssue({ code: "custom", path: ["choices"], message: "Structured choices must contain two or three {label, consequence} entries" });
    if (value.recommended && rawChoices.length === 0)
      ctx.addIssue({ code: "custom", path: ["recommended"], message: "Recommended requires a choice label" });
    if (value.recommended && rawChoices.length && !rawChoices.some(choice => (typeof choice === "string" ? choice : choice.label) === value.recommended))
      ctx.addIssue({ code: "custom", path: ["recommended"], message: "Recommended must match one choice label" });
  })
  .transform(value => {
    const choices = (value.choices ?? []).map(choice => typeof choice === "string" ? choice : choice.label);
    const choiceDetails = value.choices?.filter((choice): choice is z.infer<typeof agentAskChoiceSchema> => typeof choice !== "string");
    return { ...value, choices, ...(choiceDetails?.length ? { choiceDetails } : {}) };
  });
export type AgentAskRequest = z.infer<typeof agentAskSchema>;

/** The routed shape of one ask, shared by the routing and decision helpers. */
export interface AgentAskShape {
  sourceAgentId?: string;
  id: string;
  kind: AgentAskKind;
  question: string;
  choices: string[];
  headline?: string;
  choiceDetails?: Array<{ label: string; consequence: string }>;
  recommended?: string;
  details?: string | null;
  /** Spec 058 slice 17: "reviewer" routes this ask to the task's retained reviewer. */
  target?: 'planner' | 'reviewer';
  /**
   * Where the planner rung of this ask goes when it is not the asking task's own
   * ladder: another task's planner ladder, or a project's fallback planner or one
   * of its named agents. Absent means this task's own ladder (the original route).
   */
  route?: AskRoute;
}

/** A planner rung addressed beyond the asking task (shared/agent-verbs `ask` recipients). */
export type AskRoute = { kind: 'project'; project: string; agent: string | null } | { kind: 'task'; taskId: string };

export type AgentAskReceipt =
  | { status: "answered"; askId: string; answer: string; answeredBy: string }
  | { status: "pending"; askId: string; detail: string };

/** The stable identity of one ask: identical content on a task is the same question. */
export const agentAskId = (
  taskId: string,
  kind: AgentAskKind,
  question: string,
  choices: readonly string[],
  compact?: Pick<AgentAskShape, "headline" | "choiceDetails" | "recommended" | "details" | "target" | "route">,
): string => {
  const includesCompact = compact && [compact.headline, compact.choiceDetails, compact.recommended, compact.details].some(value => value !== undefined && value !== null);
  if (compact?.route) return digest(JSON.stringify(["agent-ask-route", taskId, kind, question, choices, compact.headline ?? null, compact.choiceDetails ?? null, compact.recommended ?? null, compact.details ?? null, compact.route]));
  if (compact?.target === "reviewer") return digest(JSON.stringify(["agent-ask-reviewer", taskId, kind, question, choices, compact.headline ?? null, compact.choiceDetails ?? null, compact.recommended ?? null, compact.details ?? null]));
  return includesCompact
    ? digest(JSON.stringify(["agent-ask-v2", taskId, kind, question, choices, compact.headline ?? null,
      compact.choiceDetails ?? null, compact.recommended ?? null, compact.details ?? null]))
    : digest(["agent-ask", taskId, kind, question, ...choices].join(":"));
};

/**
 * The content digest that joins a `nucleus_ask` call to a question Queue
 * itself raised on this task (joint, budget, proof): the prompt gives the thread
 * the exact question text and options, so their digest is the join key.
 */
export const queueAskDeliveryId = (
  taskId: string,
  question: string,
  options: readonly string[],
): string => digest(["agent-ask", taskId, question, ...options].join(":"));

/** Read `answered by <who>: <answer>` out of an `agent_ask_answered` detail. */
export function parseAgentAskAnswer(
  detail: string,
): { who: string; answer: string } | null {
  const body = detail.slice(detail.indexOf(":") + 1).trim();
  const match = /^answered by (.+?):\s*([\s\S]*)$/.exec(body);
  return match ? { who: match[1]!.trim(), answer: match[2]!.trim() } : null;
}

/**
 * Who answered a Queue-raised question, from its settle event's trailing
 * `— answered by <who>` marker; an event recorded before that marker existed
 * reads as the operator, which is who those events were recorded for.
 */
const QUEUE_ANSWER_MARKER = " — answered by ";

export function queueAnswerWho(detail: string): string {
  const body = detail.slice(detail.indexOf(":") + 1);
  const marker = body.lastIndexOf(QUEUE_ANSWER_MARKER);
  return marker < 0 ? "operator" : body.slice(marker + QUEUE_ANSWER_MARKER.length).trim();
}

/** The answer text of a Queue-raised question's settle event, without its who marker. */
export function queueAnswerText(detail: string): string {
  const body = detail.slice(detail.indexOf(":") + 1);
  const marker = body.lastIndexOf(QUEUE_ANSWER_MARKER);
  return (marker < 0 ? body : body.slice(0, marker)).trim();
}

/**
 * Task 561: the run-identity rules `nucleus_ask` shares with
 * `nucleus_report`. A stored run asks only while it is the task's live
 * current run for its role — the same current-run identity gate its report
 * passes — and a settled or released run never asks again (report's
 * completed-run correction case is report-specific; an ask never reopens a
 * settled run). The initial worker lives on the task row, never as a run, so
 * its own live binding asks as the worker; and a binding whose role genuinely
 * moved on is refused with that current owner named.
 */
function askBinding(store: Store, task: Task, runId: string): Pick<Run, 'id' | 'role' | 'agentId' | 'hostId'> {
  const run = store.run(runId);
  if (!task.hostId || (run && run.hostId !== task.hostId)) throw Error('Waiting for a proven run host');
  if (run) {
    const currentRunId = run.role === 'recovery' ? task.resolution.recovery?.runId : task.resolution.currentRunId;
    if (run.taskId !== task.id || currentRunId !== run.id || run.released || run.completion
      || (['closeout', 'recovery'].includes(run.role) && run.generation !== task.coordinatorGeneration))
      throw askStale(store, task, runId);
    return run;
  }
  if (runId !== task.runId || !task.runId || task.completion) throw askStale(store, task, runId);
  if (!['working', 'dispatching', 'needs_attention'].includes(task.phase) && !ownerArmedRetainedWorker(task, store.runs(task.id))) throw askStale(store, task, runId);
  if (supersededByPendingResume(task, runId) || (runId === task.runId && liveResumeRunSupersedes(store.runs(task.id), task.agentId, runId))) {
    recordSupersededRunRefusal(store, task.id, runId);
    throw Error(supersededResumeRefusal(runId));
  }
  if (task.resolution.currentRunId && task.resolution.currentRunId !== runId) {
    const current = store.run(task.resolution.currentRunId);
    if (current && current.taskId === task.id && !current.released && !current.completion && current.role === 'revision') throw askStale(store, task, runId);
  }
  return { id: task.runId, role: 'revision', agentId: task.agentId, hostId: task.hostId };
}
/** A superseded ask refusal names the run that owns the role now; without one it stays the plain stale refusal. */
function askStale(store: Store, task: Task, suppliedRunId: string): Error {
  if (task.resolution.currentRunId && task.resolution.currentRunId !== suppliedRunId) {
    const current = store.run(task.resolution.currentRunId);
    if (current && current.taskId === task.id && !current.released && current.agentId) return Error(`Stale reporting run; run ${suppliedRunId} is superseded — the current ${current.role === 'reviewer' ? 'reviewer' : 'worker'} owner is ${current.agentId} (run ${current.id})`);
  }
  const liveReviewer = store.runs(task.id).find(candidate => candidate.role === 'reviewer' && candidate.taskId === task.id && !candidate.released && !candidate.completion && candidate.id !== suppliedRunId && candidate.agentId);
  if (liveReviewer) return Error(`Stale reporting run; run ${suppliedRunId} is superseded — the current reviewer owner is ${liveReviewer.agentId} (run ${liveReviewer.id})`);
  if (task.agentId && task.runId && task.runId !== suppliedRunId && !task.completion) return Error(`Stale reporting run; run ${suppliedRunId} is superseded — the current worker owner is ${task.agentId} (run ${task.runId})`);
  return Error('Stale reporting run');
}

export { askBinding, askStale };
