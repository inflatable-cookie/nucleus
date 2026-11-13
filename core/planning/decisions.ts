import { randomUUID } from "node:crypto";
import { clipDecisionQuestion, DECISION_QUESTION_MAX, decisionLinksSchema, decisionSchema, storedDecisionSchema, decisionVersionSchema, type Decision, type DecisionVersion, type DecisionView, type Project, type Task } from "../../shared/contracts";
import { isOperatorOrigin, taskPlanner } from "../../shared/contracts";
import { parseAgentId, sameCallerIdentity } from "../../shared/agent-identity";
import { UNKNOWN_ASKER_LABEL } from "../../shared/decision-project";
import type { Store } from "../store/store";
import { normalizeRepositoryOrigin } from "../../shared/lanes";

/** Where Nucleus placed a decision's project: the caller's run, their planner or agent scope, or linked records. */
export type DecisionPlacingScope = "run" | "planner" | "agent" | "links" | "operator";

/** The board role Nucleus names for a run-ticket asker. */
export type DecisionAskerRole = "worker" | "reviewer" | "coordinator" | "executor";

/** A repository identity as stored on a decision's asker. */
export interface DecisionRepository { origin: string; path: string }

export interface DecisionPlacing {
  /** The caller's own project: their run's task repository, their planner or agent scope, or tasks they plan. */
  callerProject: DecisionRepository | null;
  /** The caller's run task, linked automatically on write. */
  callerTaskId: string | null;
  role: DecisionAskerRole | null;
  scope: DecisionPlacingScope | null;
  /** The unanimous project of the linked tasks, leads and papercuts. */
  linkedProject: DecisionRepository | null;
  /** Several tasks or projects match, so nothing may be inferred. */
  ambiguous: boolean;
  /** Who asked, for the board. Never a bare agent or thread ID. */
  askerLabel: string;
}

const UNPLACEABLE_DECISION_MESSAGE =
  "Nucleus could not place this decision on a project: pass the asking repository as `project`, or link the task it belongs to with `tasks`.";

const now = () => new Date().toISOString();
/** Union that keeps the existing order and drops duplicates, so linking twice is idempotent. */
const mergeLinks = (current: string[], added?: string[]): string[] => [...new Set([...current, ...(added ?? [])])];
const sameLinks = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

/** The delivery identity of one decision version; re-answering a version can never resend it. */
export const decisionNoticeId = (id: string, version: number) => `decision:${id}:${version}`;

/**
 * The durable notice an answered decision sends to the asking agent's thread.
 * Its words are the operator's answer, relayed by an agent when one recorded it.
 */
export function decisionNoticeText(decision: Decision): string {
  const answer = decision.answer;
  if (!answer) throw new Error("Decision has no answer to deliver");
  return ["A recorded decision has the operator's answer",
    `Question: ${decision.question}`,
    `Decision: ${decision.id} (version ${decision.version})`,
    `Asked by: ${decision.askedBy.agentId}`,
    `Answer: ${answer.text}`,
    `Recorded by: ${answer.answeredBy}${answer.relayed ? ` (relayed for the operator)` : " (operator authority)"}`,
    "This records a ruling only; it grants no execution authority and changes no task, lead or papercut.",
    "An agent that resumes can list its decisions with decision.list; there is nothing to approve or retry."].join("\n");
}

type Content = Pick<Decision, "question" | "context" | "options" | "recommendation" | "headline" | "choices" | "recommended" | "details" | "status" | "answer" | "withdrawal" | "supersededBy">;
const compactChoices = (choices: Decision["choices"], options: string[] | undefined, preferred?: string) => {
  if (choices?.length) return choices;
  if (options?.length) {
    const labels = preferred && options.includes(preferred)
      ? [preferred, ...options.filter(label => label !== preferred).slice(0, 2)] : options.slice(0, 3);
    if (labels.length === 1) labels.push("Keep the task held");
    return labels.map(label => ({ label: label.slice(0, 120), consequence: `Records the direction “${label.slice(0, 120)}” for the asking thread to carry out.` }));
  }
  return [
    { label: 'Return to the planner with a recommendation', consequence: 'The planner develops concrete options before asking the operator again.' },
    { label: 'Keep the task held', consequence: 'Leaves the current work and hold in place pending a planning ruling.' },
  ];
};
const OLD_DEFAULT_LABELS = new Set(["Approve", "Decline", "Answer in my own words"]);
const OLD_PLACEHOLDER_CONSEQUENCES = new Set(["Choose this direction.", "Accept the proposed direction."]);
const recommendedFirst = (choices: NonNullable<Decision["choices"]>, recommended: string) => {
  const picked = choices.find(choice => choice.label === recommended);
  return picked ? [picked, ...choices.filter(choice => choice !== picked)] : choices;
};
/**
 * Tom, 2026-11-13: a headline never starts mid-sentence. The first sentence
 * is the headline: a sentence ends only at `.`, `!` or `?` followed by
 * whitespace or the end of the text, so dots inside tokens (`.md`, `7.0.0`)
 * never split it and a later question mark never wins over the start. A dot
 * that finishes a known abbreviation (`e.g.`, `i.e.`) never ends the sentence
 * even before whitespace.
 */
const SENTENCE_ABBREVIATIONS = new Set([
  "e.g", "eg", "i.e", "ie", "etc", "vs", "mr", "mrs", "ms", "dr", "prof",
  "sr", "jr", "st", "fig", "cf", "ex", "approx", "appt", "dept", "est",
]);
const endsAbbreviation = (normalized: string, dot: number): boolean => {
  const token = normalized.slice(0, dot).match(/[A-Za-z][A-Za-z.]*$/)?.[0] ?? "";
  return SENTENCE_ABBREVIATIONS.has(token.toLowerCase());
};
const questionSentence = (question: string): string => {
  const normalized = question.replace(/\s+/g, " ").trim();
  const boundary = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(normalized)) !== null) {
    if (match[0] === "." && endsAbbreviation(normalized, match.index)) continue;
    return normalized.slice(0, match.index + 1).trim();
  }
  return normalized;
};
/** The sentence the retired headline derived, kept only to recognize stored headlines it produced. */
const retiredQuestionSentence = (question: string): string => {
  const normalized = question.replace(/\s+/g, " ").trim();
  const matches = [...normalized.matchAll(/[^.!?]+[!?](?=\s|$)/g)];
  return (matches.at(-1)?.[0] ?? normalized).trim();
};
const boundedHeadline = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const limit = Math.max(0, max - 1);
  const boundary = text.slice(0, limit + 1).lastIndexOf(" ");
  return `${text.slice(0, boundary > 0 ? boundary : limit).trimEnd()}…`;
};
const headlineFor = (headline: string | undefined, question: string, taskReference?: string | null) => {
  if (headline) return headline.replace(/\s+/g, " ").trim().slice(0, 140);
  const sentence = questionSentence(question);
  const prefix = taskReference ? `${taskReference} · ` : "";
  return boundedHeadline(prefix + sentence, 140);
};
export const decisionHeadline = (question: string, taskReference?: string | null): string => headlineFor(undefined, question, taskReference);

/**
 * Who asked, when no scope resolves: a human name passes through, a machine
 * thread identity reads as an earlier thread instead of a bare ID. The full
 * identity stays on the stored record for forensics.
 */
export function fallbackAskerLabel(askedBy: string): string {
  if (isOperatorOrigin(askedBy)) return "operator";
  try { if (parseAgentId(askedBy)) return UNKNOWN_ASKER_LABEL; } catch { return UNKNOWN_ASKER_LABEL; }
  // A bare value in an unmistakably machine shape is a thread ID, not a name.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(askedBy)
    || askedBy.startsWith("nucleus-thread-")) return UNKNOWN_ASKER_LABEL;
  return askedBy;
}
const detailsFor = (details: string | null | undefined, context: string | null | undefined, question: string) =>
  details ?? (context && question.length > 140 ? `Full question:\n${question}\n\n${context}` : context ?? (question.length > 140 ? question : null));

/**
 * Spec 032: operator decisions. A decision records a question an agent needs the
 * operator to rule on, the operator's answer, and its delivery to the asker. It
 * grants no execution authority and changes no task, lead or papercut state.
 */
export class Decisions {
  constructor(private store: Store) {}

  add(input: { question: string; headline?: string; choices?: Decision["choices"]; recommended?: string; details?: string | null; context?: string | null; options?: string[]; recommendation?: string | null; askedBy: string;
    project?: Decision["askedBy"]["project"]; tasks?: string[]; leads?: string[]; papercuts?: string[]; by?: string }): DecisionView {
    const stamp = now();
    const by = input.by ?? input.askedBy;
    const preferred = input.recommended ?? input.options?.find(label => input.recommendation?.includes(label));
    const choices = compactChoices(input.choices, input.options, preferred);
    const recommended = preferred ?? choices[0]?.label;
    if (recommended && !choices.some(choice => choice.label === recommended)) throw new Error("Recommended must match one choice label");
    // Every board decision is tied to a project: the caller's run, planner or
    // agent scope places it, else the linked records do. An explicit project
    // that contradicts the caller's identity is refused, and a decision
    // Nucleus cannot place is refused instead of filing under General.
    const explicit = this.projectOf(input.project ?? null);
    const placing = this.placingFor({ askedBy: input.askedBy, tasks: input.tasks, leads: input.leads, papercuts: input.papercuts });
    if (placing.callerProject && explicit && !this.sameProjectIdentity(placing.callerProject, explicit))
      throw new Error(`Decision project contradicts the asking thread: ${placing.askerLabel} works on ${this.repositoryLabel(placing.callerProject)} but named ${this.repositoryLabel(explicit)}. Ask from the thread that works on that project instead.`);
    const project = placing.scope === "run" ? placing.callerProject! : explicit ?? placing.callerProject ?? placing.linkedProject;
    if (!project) throw new Error(UNPLACEABLE_DECISION_MESSAGE);
    const tasks = placing.callerTaskId && !(input.tasks ?? []).includes(placing.callerTaskId)
      ? [placing.callerTaskId, ...(input.tasks ?? [])] : (input.tasks ?? []);
    const taskReference = tasks[0] ? this.taskReference(tasks[0]) : null;
    const record = decisionSchema.parse({
      id: randomUUID(), version: 1, question: input.question, headline: headlineFor(input.headline, input.question, taskReference),
      ...(choices.length ? { choices: recommended ? recommendedFirst(choices, recommended) : choices } : {}), ...(recommended ? { recommended } : {}),
      details: detailsFor(input.details, input.context, input.question), context: input.context ?? null,
      options: input.options ?? [], recommendation: input.recommendation ?? null,
      askedBy: { agentId: input.askedBy, project }, status: "open",
      links: { tasks, leads: input.leads ?? [], papercuts: input.papercuts ?? [] },
      answer: null, withdrawal: null, supersededBy: null, delivery: null,
      createdAt: stamp, updatedAt: stamp, versions: [],
    });
    return this.view(this.store.addDecision({ ...record, versions: [this.snapshot(record, by, stamp)] }));
  }

  get(input: { id: string }): DecisionView { return this.view(this.store.decision(input.id)); }

  list(query: { status?: Decision["status"]; asker?: string; project?: string; task?: string; lead?: string; papercut?: string }): DecisionView[] {
    return this.store.listDecisions(query).map(decision => this.view(decision));
  }

  answer(input: { id: string; version: number; answer: string; answeredBy: string; relayed: boolean; note: string; overtakes?: string[] }): DecisionView {
    const relayed = input.relayed;
    if (relayed && (input.answeredBy === "operator" || input.answeredBy === "operator (board)"))
      throw new Error("A relayed answer names the relaying agent, not the operator");
    if (!relayed && input.answeredBy !== "operator" && input.answeredBy !== "operator (board)")
      throw new Error("Only the operator answers without a relay; set relayed true and name the relaying agent");
    if (relayed && !input.note.trim()) throw new Error("A relayed answer requires a note quoting the operator's authorization");
    return this.store.transaction(() => {
      const current = this.requireOpen(input.id, input.version);
      const next = current.version + 1;
      const overtakes = [...new Set(input.overtakes ?? [])];
      if (overtakes.includes(current.id)) throw new Error("A decision answer cannot overtake itself");
      const answer = { text: input.answer, answeredBy: input.answeredBy, answeredAt: now(),
        relayed: relayed ? input.answeredBy : null, note: input.note, overtakes };
      // A stored record keeps its question as recorded (lenient parse); only
      // the view clips it, so an over-limit row stays answerable.
      const updated = storedDecisionSchema.parse({ ...current, ...this.transition(current, { answer, status: "answered" }), version: next,
        updatedAt: now(),
        // The asker relaying the operator's answer already has it; notifying its own thread
        // only spent a turn (Tom, 2026-09-29).
        delivery: relayed && input.answeredBy === current.askedBy.agentId ? null
          : { version: next, status: "pending", noticeId: decisionNoticeId(current.id, next), agentId: current.askedBy.agentId,
            text: decisionNoticeText({ ...current, answer, version: next }), error: "", attempts: 0, deliveredAt: null },
        versions: [...current.versions, this.snapshot({ ...current, answer, status: "answered" }, input.answeredBy, now(), next)] });
      const answered = this.store.updateDecision(updated);
      for (const id of overtakes) this.markOvertaken(id, { kind: "decision_answer", id: current.id, label: `Answer to: ${current.headline ?? current.question}`, at: answer.answeredAt });
      return this.view(answered);
    });
  }

  /** Records an exact author-supplied reference from a ruling or brief amendment. */
  markOvertaken(id: string, reference: NonNullable<Decision["overtakenBy"]>[number]): Decision {
    const target = this.store.decision(id);
    if (target.id === reference.id || target.id === reference.sourceId) throw new Error("A decision cannot overtake itself");
    if (target.status !== "open") return target;
    const existing = target.overtakenBy ?? [];
    if (existing.some(item => item.kind === reference.kind && item.id === reference.id && item.sourceId === reference.sourceId)) return target;
    return this.store.updateDecision({ ...target, overtakenBy: [...existing, reference].slice(-100) });
  }

  /**
   * Adds task, lead and papercut links to an open decision in place, so a link is
   * recorded without superseding the decision and churning its id (task #231).
   * Each named list is merged into the current links; an omitted list is unchanged
   * and an already-linked entry is not repeated. A call that adds nothing is a
   * no-op: it writes no version and no history entry. Snapshots whose links were
   * never recorded stay unknown (`null`); they are never filled from the current
   * record, which would fabricate history for imported decisions.
   */
  link(input: { id: string; version: number; tasks?: string[]; leads?: string[]; papercuts?: string[]; by?: string }): DecisionView {
    return this.store.transaction(() => {
      const current = this.requireOpen(input.id, input.version);
      const links = decisionLinksSchema.parse({
        tasks: mergeLinks(current.links.tasks, input.tasks),
        leads: mergeLinks(current.links.leads, input.leads),
        papercuts: mergeLinks(current.links.papercuts, input.papercuts),
      });
      if (sameLinks(links.tasks, current.links.tasks) && sameLinks(links.leads, current.links.leads)
        && sameLinks(links.papercuts, current.links.papercuts)) return this.view(current);
      const next = current.version + 1;
      const stamp = now();
      const updated = storedDecisionSchema.parse({ ...current, links, version: next, updatedAt: stamp,
        versions: [...current.versions, this.snapshot({ ...current, links }, input.by ?? "operator", stamp, next)] });
      return this.view(this.store.updateDecision(updated));
    });
  }

  withdraw(input: { id: string; version: number; reason: string; withdrawnBy: string }): DecisionView {
    return this.store.transaction(() => this.withdrawInTransaction(input));
  }

  /** Withdraws an open decision inside a transaction already owned by the caller. */
  withdrawInTransaction(input: { id: string; version: number; reason: string; withdrawnBy: string }): DecisionView {
    const current = this.requireOpen(input.id, input.version);
    const stamp = now();
    const withdrawal = { reason: input.reason, withdrawnBy: input.withdrawnBy, withdrawnAt: stamp };
    const updated = storedDecisionSchema.parse({ ...current, ...this.transition(current, { withdrawal, status: "withdrawn" }), version: current.version + 1,
      updatedAt: stamp,
      versions: [...current.versions, this.snapshot({ ...current, withdrawal, status: "withdrawn" }, input.withdrawnBy, stamp, current.version + 1)] });
    return this.view(this.store.updateDecision(updated));
  }

  /** Replaces an open decision with a new one in one transaction; the new decision is open. */
  supersede(input: { id: string; version: number; by: string; question: string; headline?: string; choices?: Decision["choices"]; recommended?: string; details?: string | null; context?: string | null; options?: string[];
    recommendation?: string | null; askedBy?: string; project?: Decision["askedBy"]["project"]; tasks?: string[]; leads?: string[]; papercuts?: string[] }): DecisionView {
    return this.store.transaction(() => {
      const current = this.requireOpen(input.id, input.version);
      const stamp = now();
      const choiceLabels = input.choices?.map(choice => choice.label) ?? input.options ?? current.options;
      const preferred = input.recommended ?? (input.choices === undefined && input.options === undefined
        ? current.recommended : choiceLabels.find(label => input.recommendation?.includes(label)));
      const choices = input.choices?.length ? input.choices : (input.options === undefined && current.choices?.length
        ? current.choices : compactChoices(undefined, input.options ?? current.options, preferred));
      const recommended = preferred ?? choices[0]?.label;
      if (recommended && !choices.some(choice => choice.label === recommended)) throw new Error("Recommended must match one choice label");
      // The replacement is a new board decision: the same placing rules apply.
      // A carried project that contradicts the new asker is refused, and the
      // caller's run task joins the links.
      const askedBy = input.askedBy ?? current.askedBy.agentId;
      const carried = input.project === undefined ? current.askedBy.project : this.projectOf(input.project);
      const placing = this.placingFor({ askedBy, tasks: input.tasks ?? current.links.tasks,
        leads: input.leads ?? current.links.leads, papercuts: input.papercuts ?? current.links.papercuts });
      if (placing.callerProject && carried && !this.sameProjectIdentity(placing.callerProject, carried))
        throw new Error(`Decision project contradicts the asking thread: ${placing.askerLabel} works on ${this.repositoryLabel(placing.callerProject)} but named ${this.repositoryLabel(carried)}. Ask from the thread that works on that project instead.`);
      const project = placing.scope === "run" ? placing.callerProject! : carried ?? placing.callerProject ?? placing.linkedProject;
      if (!project) throw new Error(UNPLACEABLE_DECISION_MESSAGE);
      const nextTasks = input.tasks ?? current.links.tasks;
      const tasks = placing.callerTaskId && !nextTasks.includes(placing.callerTaskId) ? [placing.callerTaskId, ...nextTasks] : nextTasks;
      const record = decisionSchema.parse({
        id: randomUUID(), version: 1, question: input.question,
        headline: headlineFor(input.headline, input.question, tasks[0] ? this.taskReference(tasks[0]) : null),
        ...(choices.length ? { choices: recommended ? recommendedFirst(choices, recommended) : choices } : {}), ...(recommended ? { recommended } : {}),
        details: input.details === undefined
          ? input.context === undefined ? current.details ?? detailsFor(undefined, current.context, input.question) : detailsFor(undefined, input.context, input.question)
          : input.details,
        context: input.context === undefined ? current.context : input.context,
        options: input.options ?? current.options,
        recommendation: input.recommendation === undefined ? current.recommendation : input.recommendation,
        askedBy: { agentId: askedBy, project },
        links: { tasks, leads: input.leads ?? current.links.leads, papercuts: input.papercuts ?? current.links.papercuts },
        status: "open", answer: null, withdrawal: null, supersededBy: null, delivery: null, createdAt: stamp, updatedAt: stamp, versions: [],
      });
      const created = this.store.addDecision({ ...record, versions: [this.snapshot(record, input.by, stamp)] });
      const updated = storedDecisionSchema.parse({ ...current, ...this.transition(current, { supersededBy: created.id, status: "superseded" }),
        version: current.version + 1, updatedAt: stamp, versions: [...current.versions, this.snapshot({ ...current, supersededBy: created.id, status: "superseded" }, input.by, stamp, current.version + 1)] });
      this.store.updateDecision(updated);
      return this.view(created);
    });
  }

  private requireOpen(id: string, version: number): Decision {
    const current = this.store.decision(id);
    if (current.version !== version) throw new Error(`Decision changed to version ${current.version}; reload before saving`);
    if (current.status !== "open") throw new Error(`Decision is ${current.status}; only an open decision changes`);
    return current;
  }

  /** `createdAt` and `delivery` are operational; the content snapshot is the versioned record. */
  private transition(current: Decision, change: Partial<Content>): Pick<Decision, keyof Content> {
    return { question: current.question, context: current.context, options: current.options, recommendation: current.recommendation,
      headline: current.headline, choices: current.choices, recommended: current.recommended, details: current.details,
      status: current.status, answer: current.answer, withdrawal: current.withdrawal, supersededBy: current.supersededBy, ...change };
  }

  private snapshot(record: Decision, by: string, at: string, version = record.version): DecisionVersion {
    // The stored version row drops undefined-valued keys; the in-memory snapshot
    // is normalized the same way so a re-read is deep-equal to what was returned.
    return decisionVersionSchema.parse(JSON.parse(JSON.stringify({ version, question: record.question, context: record.context, options: record.options,
      recommendation: record.recommendation, headline: record.headline, choices: record.choices, recommended: record.recommended,
      details: record.details, links: record.links, status: record.status, answer: record.answer,
      withdrawal: record.withdrawal, supersededBy: record.supersededBy, by, at })));
  }

  private view(decision: Decision): DecisionView {
    // A stored record over the view's limit clips here with a marker instead of
    // breaking the read. The stored row is never rewritten; the full text stays
    // in the row (and, for clipped producers, in the decision's details).
    if (decision.question.length > DECISION_QUESTION_MAX) decision = { ...decision, question: clipDecisionQuestion(decision.question) };
    const asking = decision.askedBy.project;
    let choices = decision.choices?.length ? decision.choices : compactChoices(undefined, decision.options);
    if (choices.length === 3 && choices.every(choice => OLD_DEFAULT_LABELS.has(choice.label))) choices = compactChoices(undefined, undefined);
    else choices = choices.map(choice => OLD_PLACEHOLDER_CONSEQUENCES.has(choice.consequence)
      ? { ...choice, consequence: "" } : choice);
    const recommended = choices.length
      ? (choices.some(choice => choice.label === decision.recommended) ? decision.recommended : choices.find(choice => decision.recommendation?.includes(choice.label))?.label ?? choices[0]?.label)
      : undefined;
    const taskReference = decision.links.tasks[0] ? this.taskReference(decision.links.tasks[0]) : null;
    const legacyHeadline = decision.question.replace(/\s+/g, " ").trim().slice(0, 140);
    // Existing decisions get a fresh headline on read from their stored
    // question: a stored headline the retired mid-sentence derivation produced
    // is recognized and re-derived. The stored question is never changed, and
    // an explicitly set headline that the retired derivation could not have
    // produced is kept.
    const prefix = taskReference ? `${taskReference} · ` : "";
    const retiredHeadline = boundedHeadline(prefix + retiredQuestionSentence(decision.question), 140);
    const headline = !decision.headline || decision.headline === legacyHeadline || decision.headline === retiredHeadline
      ? headlineFor(undefined, decision.question, taskReference) : decision.headline;
    const normalized = { ...decision };
    if (!choices.length) delete normalized.choices;
    if (!recommended) delete normalized.recommended;
    const askerLabel = this.placingFor({ askedBy: decision.askedBy.agentId,
      tasks: decision.links.tasks, leads: decision.links.leads, papercuts: decision.links.papercuts }).askerLabel;
    return { ...normalized, askerLabel, headline,
      ...(choices.length ? { choices: recommended ? recommendedFirst(choices, recommended) : choices } : {}), ...(recommended ? { recommended } : {}),
      details: detailsFor(decision.details, decision.context, decision.question), overtakenBy: decision.overtakenBy ?? [],
      stale: this.stale(decision), projectKey: asking ? this.store.projectFor(asking.path, asking.origin)?.key ?? null : null };
  }
  private taskReference(taskId: string): string | null {
    try { return this.store.task(taskId).reference ?? null; } catch { return null; }
  }
  /**
   * Each thread's project for the composer pill: the task the agent works on
   * names it, else the project whose repository path holds the working directory.
   */
  agentProjects(input: { agents: Array<{ agentId: string; cwd: string }> }): Array<{ agentId: string; project: { key: string; name: string } | null }> {
    const projects = this.store.projects();
    const inside = (cwd: string, path: string) => Boolean(path) && (cwd === path || cwd.startsWith(path.endsWith("/") ? path : `${path}/`));
    return input.agents.map(({ agentId, cwd }) => {
      const taskId = this.store.taskIdsForIdentities({ agentId })[0];
      let project = null as (typeof projects)[number] | null;
      if (taskId) { try { const task = this.store.task(taskId); project = this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? "")); } catch { project = null; } }
      project ??= projects.find(candidate => candidate.repositories.some(repo => repo.path && inside(cwd, repo.path))) ?? null;
      return { agentId, project: project ? { key: project.key, name: project.name } : null };
    });
  }

  private projectOf(project: Decision["askedBy"]["project"]): Decision["askedBy"]["project"] {
    return project ? this.store.resolveRepositoryIdentity(project) : project;
  }

  /**
   * Every board decision is tied to a project. The caller's identity places it:
   * a run ticket (worker, reviewer, coordinator, executor) gives the task, its
   * repository and its project; a planner or named-agent participant ticket
   * gives its project (a task planner falls back to the unanimous project of
   * the tasks it plans); otherwise the linked tasks, leads or papercuts give
   * the project. The operator places only what they name. Nothing here throws:
   * writes refuse a contradiction or an unplaceable decision, reads label what
   * they cannot place, and the backfill counts both.
   */
  placingFor(input: { askedBy: string; tasks?: string[]; leads?: string[]; papercuts?: string[] }): DecisionPlacing {
    const askedBy = input.askedBy;
    const linked = this.linkedProject(input);
    if (isOperatorOrigin(askedBy))
      return { callerProject: null, callerTaskId: null, role: null, scope: "operator",
        linkedProject: linked.project, ambiguous: false, askerLabel: "operator" };
    const run = this.runScopeFor(askedBy);
    if (run && "ambiguous" in run)
      return { callerProject: null, callerTaskId: null, role: null, scope: null,
        linkedProject: linked.project, ambiguous: true, askerLabel: fallbackAskerLabel(askedBy) };
    if (run) {
      const project = this.taskProjectIdentity(run.task);
      return { callerProject: project, callerTaskId: run.task.id, role: run.role, scope: "run",
        linkedProject: linked.project, ambiguous: false,
        askerLabel: `${run.task.reference ?? run.task.id.slice(0, 8)} ${run.role}` };
    }
    const scoped = this.participantScopeFor(askedBy);
    if (scoped && "ambiguous" in scoped)
      return { callerProject: null, callerTaskId: null, role: null, scope: null,
        linkedProject: linked.project, ambiguous: true, askerLabel: fallbackAskerLabel(askedBy) };
    if (scoped)
      return { callerProject: this.primaryRepository(scoped.project),
        callerTaskId: null, role: null, scope: scoped.scope, linkedProject: linked.project,
        ambiguous: false, askerLabel: scoped.label };
    const planned = this.plannedScopeFor(askedBy);
    if (planned && "ambiguous" in planned)
      return { callerProject: null, callerTaskId: null, role: null, scope: null,
        linkedProject: linked.project, ambiguous: true, askerLabel: fallbackAskerLabel(askedBy) };
    if (planned)
      return { callerProject: this.primaryRepository(planned.project),
        callerTaskId: null, role: null, scope: "planner", linkedProject: linked.project,
        ambiguous: false, askerLabel: `${planned.project.name} planner` };
    return { callerProject: null, callerTaskId: null, role: null, scope: linked.project ? "links" : null,
      linkedProject: linked.project, ambiguous: linked.ambiguous, askerLabel: fallbackAskerLabel(askedBy) };
  }

  /** The repository identity a decision carries for a project: its primary, else its only repository. */
  private primaryRepository(project: Project): DecisionRepository {
    const primary = project.primary ?? project.repositories[0]!;
    return { origin: primary.origin ?? primary.path, path: primary.path };
  }

  /**
   * Project-less decisions the asker can still place gain the asker's project.
   * The project is not versioned content, so the row is retargeted in place:
   * no version is written and no history is fabricated. Ambiguous askers and
   * unresolvable links are left as is. The planner runs the real backfill after
   * merge; the dry run reports the counts first.
   */
  backfillDecisionProjects(dryRun = true): { total: number; resolved: number; ambiguous: number; unresolvable: number; updated: number } {
    let total = 0, resolved = 0, ambiguous = 0, updated = 0;
    for (const row of this.store.listDecisions()) {
      if (row.askedBy.project) continue;
      total++;
      const placing = this.placingFor({ askedBy: row.askedBy.agentId,
        tasks: row.links.tasks, leads: row.links.leads, papercuts: row.links.papercuts });
      const project = placing.callerProject ?? placing.linkedProject;
      if (!project) { if (placing.ambiguous) ambiguous++; continue; }
      resolved++;
      if (!dryRun) {
        this.store.updateDecision({ ...row, askedBy: { ...row.askedBy, project } });
        updated++;
      }
    }
    return { total, resolved, ambiguous, unresolvable: total - resolved - ambiguous, updated };
  }

  /** The task a run-ticket asker works on, with the board role Nucleus names. */
  private runScopeFor(askedBy: string): { task: Task; role: DecisionAskerRole } | { ambiguous: true } | null {
    const ids = new Set<string>();
    for (const id of this.store.taskIdsForIdentities({ agentId: askedBy })) ids.add(id);
    if (!ids.size) {
      // A qualified caller on a host whose stored rows are still bare (or the
      // reverse on Paseo): match the native identity the same way the board's
      // thread lookup does. A match spanning hosts stays ambiguous.
      const hosts = new Set<string | null>();
      for (const task of this.store.liveTasks()) {
        if (![task.agentId, task.coordinatorAgentId, task.resolution?.reviewerAgentId]
          .some(value => value && sameCallerIdentity(askedBy, value))) continue;
        ids.add(task.id);
        hosts.add(task.hostId ?? null);
      }
      if (ids.size && (hosts.size > 1 || hosts.has(null))) return { ambiguous: true };
    }
    if (!ids.size) return null;
    const tasks: Task[] = [];
    for (const id of ids) { try { tasks.push(this.store.task(id)); } catch { /* purged since the lookup */ } }
    if (!tasks.length) return null;
    if (tasks.length === 1) { const task = tasks[0]!; return { task, role: this.roleForAsker(task, askedBy) }; }
    const live = tasks.filter(task => this.store.runs(task.id)
      .some(run => !run.released && run.agentId && sameCallerIdentity(askedBy, run.agentId)));
    if (live.length === 1) { const task = live[0]!; return { task, role: this.roleForAsker(task, askedBy) }; }
    return { ambiguous: true };
  }

  private roleForAsker(task: Task, askedBy: string): DecisionAskerRole {
    const runs = this.store.runs(task.id).filter(run => run.agentId && sameCallerIdentity(askedBy, run.agentId));
    const run = runs.find(candidate => !candidate.released) ?? runs.at(-1);
    if (run) {
      if (run.role === "reviewer") return "reviewer";
      if (run.role === "executor") return "executor";
      if (run.role === "recovery" || run.role === "verification" || run.role === "closeout") return "coordinator";
      return "worker";
    }
    if (task.coordinatorAgentId && sameCallerIdentity(askedBy, task.coordinatorAgentId)) return "coordinator";
    if (task.resolution?.reviewerAgentId && sameCallerIdentity(askedBy, task.resolution.reviewerAgentId)) return "reviewer";
    return "worker";
  }

  /** A project planner or named agent speaks for their project. */
  private participantScopeFor(askedBy: string): { scope: "planner" | "agent"; project: Project; label: string } | { ambiguous: true } | null {
    const matches: Array<{ scope: "planner" | "agent"; project: Project; label: string }> = [];
    for (const project of this.store.projects()) {
      if (project.planner?.agentId && sameCallerIdentity(askedBy, project.planner.agentId))
        matches.push({ scope: "planner", project, label: `${project.name} planner` });
      for (const agent of project.agents ?? [])
        if (sameCallerIdentity(askedBy, agent.agentId)) matches.push({ scope: "agent", project, label: agent.name });
    }
    if (new Set(matches.map(match => match.project.key)).size > 1) return { ambiguous: true };
    if (!matches.length) return null;
    return matches.find(match => match.scope === "planner") ?? matches[0]!;
  }

  /** A task planner with no project scope speaks for the unanimous project of the tasks they plan. */
  private plannedScopeFor(askedBy: string): { project: Project } | { ambiguous: true } | null {
    const projects: Project[] = [];
    for (const task of this.store.liveTasks()) {
      if (!sameCallerIdentity(askedBy, taskPlanner(task))) continue;
      const project = this.store.projectFor(task.repoPath, normalizeRepositoryOrigin(task.repository ?? ""));
      if (project && !projects.some(candidate => candidate.key === project.key)) projects.push(project);
    }
    if (projects.length > 1) return { ambiguous: true };
    return projects[0] ? { project: projects[0] } : null;
  }

  /** The unanimous project of the linked tasks, leads and papercuts; a split is ambiguous. */
  private linkedProject(input: { tasks?: string[]; leads?: string[]; papercuts?: string[] }): { project: DecisionRepository | null; ambiguous: boolean } {
    const repos: DecisionRepository[] = [];
    for (const id of input.tasks ?? []) {
      try {
        const task = this.store.task(id);
        repos.push(this.taskProjectIdentity(task));
      } catch { /* a purged or missing link resolves nothing */ }
    }
    for (const id of input.leads ?? []) {
      try { for (const repo of this.store.lead(id).repositories) repos.push({ origin: repo.origin, path: repo.path }); }
      catch { /* a missing link resolves nothing */ }
    }
    for (const id of input.papercuts ?? []) {
      try { const repo = this.store.papercut(id).repository; repos.push({ origin: repo.origin, path: repo.path }); }
      catch { /* a missing link resolves nothing */ }
    }
    if (!repos.length) return { project: null, ambiguous: false };
    if (new Set(repos.map(repo => this.projectIdentityKey(repo))).size > 1) return { project: null, ambiguous: true };
    return { project: repos[0]!, ambiguous: false };
  }

  /** A task's repository identity: a task whose repository no project holds is placed on its own repository, not General. */
  private taskProjectIdentity(task: Task): DecisionRepository {
    return { origin: normalizeRepositoryOrigin(task.repository ?? "") ?? task.repoPath, path: task.repoPath };
  }

  private projectIdentityKey(repo: DecisionRepository): string {
    return this.store.projectFor(repo.path, repo.origin)?.key ?? `repo:${repo.origin}\n${repo.path}`;
  }

  private sameProjectIdentity(left: DecisionRepository, right: DecisionRepository): boolean {
    return this.projectIdentityKey(left) === this.projectIdentityKey(right);
  }

  /** The short project name the board shows for a repository identity. */
  private repositoryLabel(repo: DecisionRepository): string {
    return repo.origin.split("/").at(-1) || repo.path.split(/[\\/]/).filter(Boolean).at(-1) || repo.path;
  }

  /**
   * An open decision whose every linked task, lead and papercut is terminal is
   * stale. It is never closed automatically: the asker or the operator withdraws it.
   */
  private stale(decision: Decision): boolean {
    if (decision.status !== "open") return false;
    const links = [decision.links.tasks.length, decision.links.leads.length, decision.links.papercuts.length];
    if (!links.some(count => count > 0)) return false;
    return decision.links.tasks.every(id => this.terminalTask(id))
      && decision.links.leads.every(id => this.terminalLead(id))
      && decision.links.papercuts.every(id => this.terminalPapercut(id));
  }

  private terminalTask(id: string): boolean {
    try { const task = this.store.task(id); return task.phase === "done" || task.phase === "cancelled"; }
    catch { return true; }
  }
  private terminalLead(id: string): boolean {
    try { return this.store.lead(id).state !== "open"; } catch { return true; }
  }
  private terminalPapercut(id: string): boolean {
    try { return this.store.papercut(id).state !== "open"; } catch { return true; }
  }
}
