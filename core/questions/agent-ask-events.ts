import { parseAgentAskAnswer } from "./agent-ask";
import type { Store } from "../store/store";

/**
 * The one decoder for one agent ask's durable lifecycle.
 *
 * Every `agent_ask_*` record writes its ask id as the detail's leading token, so
 * the ask's state is those records read together. This module reads each record
 * once, per ask id, and hands callers typed facts — asked, answered, joined,
 * superseded, who was asked, what a reviewer ruled, whether a delivery is
 * unknown, whether the answer was resumed. No lifecycle reader in the ask
 * service compares event text again.
 */
export interface AskLifecycle {
  id: string;
  /** Ordering fact: the ask's own record time, ISO. */
  askedAt: string | null;
  asked: boolean;
  kind: string | null;
  runId: string | null;
  agentId: string | null;
  answered: { who: string; answer: string } | null;
  /** The Queue-raised question this ask joined, when it joined one. */
  joined: string | null;
  /** The operator decision this ask links, when one was created for it. */
  decisionId: string | null;
  reviewer: string | null;
  planner: { agentId: string; rung: "task" | "project" | "planner" } | null;
  deciderStarted: boolean;
  planningRuling: boolean;
  planningRulingDetail: string | null;
  reviewerMissed: boolean;
  /** A delegation miss that recorded no planner or decider classification. */
  noClassification: boolean;
  delegationUnknown: boolean;
  hostWait: boolean;
  resumed: boolean;
  resumeIntent: boolean;
  superseded: boolean;
}

/** What one event record says about the ask whose id leads its detail. */
interface AskEventFact {
  id: string;
  kind: string;
  body: string;
  at: string;
  detail: string;
}

/** Split one ask-scoped record into its ask id and the rest; null when it is not ask-scoped. */
function askEventFact(event: { kind: string; detail: string; at?: string }): AskEventFact | null {
  if (!event.kind.startsWith("agent_ask")) return null;
  if (event.kind === "agent_ask_payload") return null;
  const separator = event.detail.indexOf(":");
  if (separator <= 0) return null;
  return { id: event.detail.slice(0, separator), kind: event.kind, body: event.detail.slice(separator + 1), at: event.at ?? "", detail: event.detail };
}

/** The durable payload of an ask, when this task recorded one for it. */
export function askPayload<T extends { id: string }>(events: ReadonlyArray<{ kind: string; detail: string }>, askId: string): T | null {
  for (const event of events) {
    if (event.kind !== "agent_ask_payload") continue;
    try {
      const payload = JSON.parse(event.detail) as T;
      if (payload?.id === askId) return payload;
    } catch { /* An invalid durable payload cannot authorize a send. */ }
  }
  return null;
}

/** Every ask this task's records name, decoded once, in the order the records were read. */
export function askLifecycles(events: ReadonlyArray<{ kind: string; detail: string; at?: string }>): Map<string, AskLifecycle> {
  const states = new Map<string, AskLifecycle>();
  const state = (id: string): AskLifecycle => {
    const existing = states.get(id);
    if (existing) return existing;
    const created: AskLifecycle = {
      id, askedAt: null, asked: false, kind: null, runId: null, agentId: null, answered: null, joined: null, decisionId: null,
      reviewer: null, planner: null, deciderStarted: false, planningRuling: false, planningRulingDetail: null,
      reviewerMissed: false, noClassification: false, delegationUnknown: false, hostWait: false, resumed: false, resumeIntent: false, superseded: false,
    };
    states.set(id, created);
    return created;
  };
  for (const event of events) {
    const fact = askEventFact(event);
    if (!fact) continue;
    const ask = state(fact.id);
    switch (fact.kind) {
      case "agent_ask": {
        ask.asked = true;
        const kind = /kind ([^;]+);/.exec(fact.body)?.[1];
        const run = /\brun (\S+) \(/.exec(fact.body)?.[1];
        const agent = /run (\S+) \([^)]+\); agent ([^;\s]+)/.exec(fact.body)?.[2];
        ask.kind = kind ?? ask.kind;
        ask.runId = run ?? ask.runId;
        ask.agentId = agent && agent !== "unknown" ? agent : ask.agentId;
        ask.askedAt = ask.askedAt ?? fact.at;
        break;
      }
      case "agent_ask_answered": {
        const parsed = parseAgentAskAnswer(fact.detail);
        if (parsed) ask.answered = parsed;
        break;
      }
      case "agent_ask_joined": {
        const joined = /queue question (\S+)/.exec(fact.body)?.[1];
        if (joined) ask.joined = joined;
        break;
      }
      case "agent_ask_decision":
        ask.decisionId = /decision ([^;\s]+)/.exec(fact.body)?.[1] ?? ask.decisionId;
        break;
      case "agent_ask_delegated": {
        const reviewer = /reviewer (.+?);/.exec(fact.body)?.[1];
        const planner = /planner (.+?);/.exec(fact.body)?.[1];
        if (reviewer) ask.reviewer = reviewer;
        else if (planner) ask.planner = { agentId: planner,
          rung: fact.body.startsWith(" task planner ") ? "task" : fact.body.startsWith(" project planner ") ? "project" : "planner" };
        else if (fact.detail.startsWith(`${fact.id}: decider`)) ask.deciderStarted = true;
        break;
      }
      case "agent_ask_planning_ruling":
        ask.planningRuling = true;
        ask.planningRulingDetail = fact.detail;
        break;
      case "agent_ask_reviewer_missed":
        ask.reviewerMissed = true;
        break;
      case "agent_ask_delegation_missed":
        if (fact.body.startsWith(" no planner or decider classification was produced;")) ask.noClassification = true;
        break;
      case "agent_ask_delegation_unknown":
        ask.delegationUnknown = true;
        break;
      case "agent_ask_host_wait":
        ask.hostWait = true;
        break;
      case "agent_ask_resumed":
        ask.resumed = true;
        break;
      case "agent_ask_resume_intent":
        ask.resumeIntent = true;
        break;
      case "agent_ask_superseded":
        ask.superseded = true;
        break;
      default:
        break;
    }
  }
  return states;
}

/** One ask's decoded lifecycle, or null when this task never recorded it. */
export function askLifecycle(events: ReadonlyArray<{ kind: string; detail: string; at?: string }>, askId: string): AskLifecycle | null {
  return askLifecycles(events).get(askId) ?? null;
}

/** The ask ids a task's records name, newest record first. */
export function askedIds(events: ReadonlyArray<{ kind: string; detail: string; at?: string }>): string[] {
  return [...askLifecycles(events).keys()];
}

/** The store reads the ask service needs; the store itself is injected as a narrow fact source. */
export type AskEventStore = Pick<Store, "eventsAll" | "maintenanceTasks" | "task">;
