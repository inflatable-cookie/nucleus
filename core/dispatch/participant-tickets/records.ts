/**
 * The participant ticket meta rows: how a ticket is addressed, what a stored
 * ticket says, and how its participant id resolves back to what it speaks for.
 * Every key this store writes is built and read here, so no caller assembles a
 * raw key or splits one on a separator to learn what a ticket is for.
 */
import type { Store } from "../../store/store";

/** How a thread received its identity: its own call, one host message, or unknown. */
export type TicketDelivery = "intent" | "self" | "delivered" | "unknown";

/**
 * One participant's identity ticket as Nucleus records it. The project, the
 * named agent and the planner assignment are absent on the scopes that do not
 * have them: a task-planner ticket carries neither project nor name, and a named
 * agent's ticket carries no assignment.
 */
export interface TicketRecord {
  participantId: string;
  projectKey?: string;
  name?: string;
  agentId: string;
  setAt?: string;
  hostId: string;
  nativeAgentId: string;
  tokenHash: string;
  path: string;
  delivery: TicketDelivery;
}

/** The identity a ticket is issued for, before the generated fields exist. */
export type TicketIdentity = Omit<TicketRecord, "participantId" | "tokenHash" | "path" | "delivery">;

/** What a participant id speaks for: the planner of a project, one named agent, or one task planner. */
export type ParticipantScope =
  | { kind: "planner"; participantId: string; projectKey: string; key: string }
  | { kind: "task-planner"; participantId: string; key: string }
  | { kind: "agent"; participantId: string; projectKey: string; name: string; key: string };

const PLANNER_PREFIX = "plannerParticipant:";
const PLANNER_PENDING_PREFIX = "plannerTicketPending:";
const TASK_PLANNER_PREFIX = "taskPlannerParticipant:";
const AGENT_PREFIX = "projectAgentParticipant:";
const AGENT_PENDING_PREFIX = "projectAgentTicketPending:";
const PLANNER_GENERATION_PREFIX = "plannerParticipantGeneration:";

export const plannerTicketKey = (project: string) => `${PLANNER_PREFIX}${project}`;
/** A planner with no usable ticket yet: the board's project entry says so. */
export const plannerTicketPendingKey = (project: string) => `${PLANNER_PENDING_PREFIX}${project}`;
/** Task 1109: one identity ticket per task-planner thread, so a planner on any host can answer. */
export const taskPlannerTicketKey = (hostId: string, nativeAgentId: string) =>
  `${TASK_PLANNER_PREFIX}${JSON.stringify([hostId, nativeAgentId])}`;
/** One participant ticket per registered named agent (Spec 060). */
export const agentTicketKey = (project: string, name: string) => `${AGENT_PREFIX}${project}:${name}`;
/** A registered agent with no usable ticket yet. */
export const agentTicketPendingKey = (project: string, name: string) => `${AGENT_PENDING_PREFIX}${project}:${name}`;
/** The write counter that revokes a planner ticket whose assignment was rewritten under it. */
export const plannerGenerationKey = (project: string) => `${PLANNER_GENERATION_PREFIX}${project}`;

const plannerParticipantIdKey = (participantId: string) => `plannerParticipantId:${participantId}`;
const taskPlannerParticipantIdKey = (participantId: string) => `taskPlannerParticipantId:${participantId}`;
const agentParticipantIdKey = (participantId: string) => `projectAgentParticipantId:${participantId}`;

/** The participant-id row that resolves a project planner's id back to its project. */
export const plannerScopeRow = (participantId: string, projectKey: string) =>
  [plannerParticipantIdKey(participantId), projectKey] as const;
/** The participant-id row that resolves a task planner's id back to its record key. */
export const taskPlannerScopeRow = (participantId: string, key: string) =>
  [taskPlannerParticipantIdKey(participantId), key] as const;
/** The participant-id row that resolves a named agent's id back to its project and name. */
export const agentScopeRow = (participantId: string, projectKey: string, name: string) =>
  [agentParticipantIdKey(participantId), { projectKey, name }] as const;

/** The named rows a participant id can resolve through, whichever scope wrote it. */
const PARTICIPANT_ID_KEYS = [plannerParticipantIdKey, taskPlannerParticipantIdKey, agentParticipantIdKey];

/** One ticket record, read as a record: a value that is not one is absent, never a match. */
function asTicket(value: unknown): TicketRecord | null {  const record = value as TicketRecord | null | undefined;
  return record && typeof record.participantId === "string" && typeof record.agentId === "string"
    && typeof record.hostId === "string" && typeof record.path === "string" ? record : null;
}

export function readTicket(store: Store, key: string): TicketRecord | null {
  return asTicket(store.getMeta<TicketRecord>(key));
}

/** Whether anything at all is recorded under this key, readable by this module or not. */
export function hasTicket(store: Store, key: string): boolean {
  return store.getMeta<unknown>(key) !== undefined;
}

/** Whether a stored record was issued for this identity, so it can be handed back unchanged. */
export function sameTicketIdentity(stored: TicketRecord, identity: TicketIdentity): boolean {
  return stored.agentId === identity.agentId && stored.hostId === identity.hostId
    && stored.setAt === identity.setAt && stored.projectKey === identity.projectKey && stored.name === identity.name;
}

/** What this participant id speaks for, read from the rows its issuance wrote. */
export function participantScopeOf(store: Store, participantId: string): ParticipantScope | null {
  const scoped = store.getMeta<{ projectKey?: string; name?: string }>(agentParticipantIdKey(participantId));
  if (scoped?.projectKey && scoped.name)
    return { kind: "agent", participantId, projectKey: scoped.projectKey, name: scoped.name, key: agentTicketKey(scoped.projectKey, scoped.name) };
  const projectKey = store.getMeta<string>(plannerParticipantIdKey(participantId));
  if (projectKey) return { kind: "planner", participantId, projectKey, key: plannerTicketKey(projectKey) };
  const taskPlannerKey = store.getMeta<string>(taskPlannerParticipantIdKey(participantId));
  return typeof taskPlannerKey === "string" ? { kind: "task-planner", participantId, key: taskPlannerKey } : null;
}

/** Drop every scope row a participant id resolves through. */
export function dropParticipantScope(store: Store, participantId: string): void {
  for (const key of PARTICIPANT_ID_KEYS) store.deleteMeta(key(participantId));
}

/** The meta rows whose key starts with `prefix`, read as raw text. */
function prefixedRows(store: Store, prefix: string): Array<{ key: string; value: string }> {
  return store.db.prepare("SELECT key, value FROM meta WHERE key GLOB ?").all(`${prefix}*`) as Array<{ key: string; value: string }>;
}

function parseValue(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** Every stored ticket record in the store, whatever scope wrote it. */
export function ticketRows(store: Store): Array<{ key: string; record: TicketRecord }> {
  const rows: Array<{ key: string; record: TicketRecord }> = [];
  for (const prefix of [PLANNER_PREFIX, TASK_PLANNER_PREFIX, AGENT_PREFIX]) {
    for (const row of prefixedRows(store, prefix)) {
      const record = asTicket(parseValue(row.value));
      if (record) rows.push({ key: row.key, record });
    }
  }
  return rows;
}

/**
 * The registered-agent rows, ticket and pending marker alike: a marker says a
 * name's ticket has not reached its thread yet, and belongs to the same name.
 */
export function agentTicketRows(store: Store): Array<{ pending: boolean; key: string; projectKey: string; name: string; agentId: string | null; participantId: string | null }> {
  const rows: Array<{ pending: boolean; key: string; projectKey: string; name: string; agentId: string | null; participantId: string | null }> = [];
  for (const pending of [false, true]) {
    const prefix = pending ? AGENT_PENDING_PREFIX : AGENT_PREFIX;
    for (const row of prefixedRows(store, prefix)) {
      const name = parseAgentMetaKey(row.key, prefix);
      if (!name) continue;
      const value = parseValue(row.value);
      if (!value) continue;
      rows.push({ pending, key: row.key, projectKey: name.projectKey, name: name.name,
        agentId: typeof value.agentId === "string" ? value.agentId : null,
        participantId: typeof value.participantId === "string" ? value.participantId : null });
    }
  }
  return rows;
}

/** A named agent's meta key splits at the first separator after its prefix; the project key never holds one. */
function parseAgentMetaKey(key: string, prefix: string): { projectKey: string; name: string } | null {
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  return { projectKey: rest.slice(0, separator), name: rest.slice(separator + 1) };
}
