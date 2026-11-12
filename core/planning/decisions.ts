import { randomUUID } from "node:crypto";
import { clipDecisionQuestion, DECISION_QUESTION_MAX, decisionLinksSchema, decisionSchema, storedDecisionSchema, decisionVersionSchema, type Decision, type DecisionVersion, type DecisionView } from "../../shared/contracts";
import type { Store } from "../store/store";
import { normalizeRepositoryOrigin } from "../../shared/lanes";

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
const questionSentence = (question: string): string => {
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
    const taskReference = input.tasks?.[0] ? this.taskReference(input.tasks[0]) : null;
    const record = decisionSchema.parse({
      id: randomUUID(), version: 1, question: input.question, headline: headlineFor(input.headline, input.question, taskReference),
      ...(choices.length ? { choices: recommended ? recommendedFirst(choices, recommended) : choices } : {}), ...(recommended ? { recommended } : {}),
      details: detailsFor(input.details, input.context, input.question), context: input.context ?? null,
      options: input.options ?? [], recommendation: input.recommendation ?? null,
      askedBy: { agentId: input.askedBy, project: this.projectOf(input.project ?? null) }, status: "open",
      links: { tasks: input.tasks ?? [], leads: input.leads ?? [], papercuts: input.papercuts ?? [] },
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
      const record = decisionSchema.parse({
        id: randomUUID(), version: 1, question: input.question,
        headline: headlineFor(input.headline, input.question, input.tasks?.[0] ? this.taskReference(input.tasks[0]) : null),
        ...(choices.length ? { choices: recommended ? recommendedFirst(choices, recommended) : choices } : {}), ...(recommended ? { recommended } : {}),
        details: input.details === undefined
          ? input.context === undefined ? current.details ?? detailsFor(undefined, current.context, input.question) : detailsFor(undefined, input.context, input.question)
          : input.details,
        context: input.context === undefined ? current.context : input.context,
        options: input.options ?? current.options,
        recommendation: input.recommendation === undefined ? current.recommendation : input.recommendation,
        askedBy: { agentId: input.askedBy ?? current.askedBy.agentId, project: input.project === undefined ? current.askedBy.project : this.projectOf(input.project) },
        links: { tasks: input.tasks ?? current.links.tasks, leads: input.leads ?? current.links.leads, papercuts: input.papercuts ?? current.links.papercuts },
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
    const headline = !decision.headline || decision.headline === legacyHeadline
      ? headlineFor(undefined, decision.question, taskReference) : decision.headline;
    const normalized = { ...decision };
    if (!choices.length) delete normalized.choices;
    if (!recommended) delete normalized.recommended;
    return { ...normalized, headline,
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
