// The two agent verbs, defined once: `ask` (a question that waits and escalates)
// and `tell` (information only). The MCP server, the `nucleus ask` / `nucleus tell`
// CLI and the service callbacks all read these shapes and targets from here, so
// a recipient means the same thing on every host. A caller never names an agent
// or thread ID: every recipient is a role of this task, a task's role, or a
// project (or a named agent of a project), resolved from the caller's own run.
import { z } from 'zod';

/** Recipients of `ask`: a question's route. `reviewer` consults this task's retained reviewer. */
export const ASK_ROUTE_KEYWORDS = Object.freeze(['reviewer', 'planner']);
/** Recipients of `tell`: this task's counterpart, its planner ladder, or a task reference's role. */
export const TELL_ROLE_KEYWORDS = Object.freeze(['reviewer', 'worker', 'planner']);
/** The roles a task reference names. */
export const TASK_ROLES = Object.freeze(['worker', 'reviewer', 'planner']);
export const VERB_TEXT_MAX_CHARS = 4000;

const name = z.string().trim().min(1).max(200);
const reference = z.string().trim().min(1).max(240);

/**
 * Every recipient form a caller may name. A keyword is this task's role; a string is
 * a task reference (`effigy#590`, a bare number, or a task id) for `tell`; an object
 * addresses a project's fallback planner (`{project}`), a named project agent
 * (`{project, agent}`) or another task's role (`{task, role}`).
 */
export const verbTargetSchema = z.union([
  z.enum(['reviewer', 'worker', 'planner']),
  reference,
  z.object({ project: name, agent: name.optional() }).strict(),
  z.object({ task: reference, role: z.enum(TASK_ROLES).optional() }).strict(),
]);

/** The ask question's board fields, unchanged from the original `nucleus_ask`. */
const askChoice = z.object({ label: z.string().trim().min(1).max(120), consequence: z.string().trim().max(240).regex(/^[^\r\n]*$/) }).strict();
export const askFieldShape = {
  question: z.string().trim().min(1).max(4000),
  headline: z.string().trim().min(1).max(140).regex(/^[^\r\n]*$/).optional(),
  choices: z.array(z.union([z.string().trim().min(1).max(400), askChoice])).max(10).optional(),
  recommended: z.string().trim().min(1).max(120).optional(),
  details: z.string().max(48000).nullable().optional(),
  kind: z.enum(['proof_acceptance', 'budget', 'review', 'scope', 'release', 'process']).optional(),
};

/** MCP input shape of `ask`. `target` is the original `nucleus_ask` hint and stays an alias of `to`. */
export const askInputShape = {
  ...askFieldShape,
  to: verbTargetSchema.optional(),
  target: z.enum(['planner', 'reviewer']).optional(),
  runId: z.string().min(1).optional(),
};

/** MCP input shape of `tell`. `role` qualifies a task reference, as `nucleus_message` did. */
export const tellInputShape = {
  to: verbTargetSchema,
  role: z.enum(TASK_ROLES).optional(),
  text: z.string().trim().min(1).max(VERB_TEXT_MAX_CHARS),
  runId: z.string().min(1).optional(),
};

/**
 * Resolve an `ask` recipient to the route it takes. `default` keeps the original
 * behaviour (a worker asks its reviewer first, a reviewer asks its planner ladder);
 * `reviewer` and `planner` name that route; `project` and `task` address another
 * project's or task's planner ladder. Nothing here reads state: the service resolves
 * the names against the record and refuses what it cannot address.
 */
export function normalizeAskTarget(to, legacyTarget) {
  if (to !== undefined && legacyTarget !== undefined && !sameAskTarget(to, legacyTarget))
    throw new Error('ask names one recipient: pass to or target, not both with different values');
  const named = to ?? legacyTarget;
  if (named === undefined) return { kind: 'default' };
  if (named === 'reviewer') return { kind: 'reviewer' };
  if (named === 'planner') return { kind: 'planner' };
  if (typeof named === 'object' && named !== null && 'project' in named)
    return { kind: 'project', project: named.project, agent: named.agent ?? null };
  if (typeof named === 'object' && named !== null && 'task' in named) {
    if (named.role !== undefined && named.role !== 'planner')
      throw new Error('ask reaches another task only through its planner: use {task, role: "planner"}; tell reaches its worker or reviewer');
    return { kind: 'task', task: named.task, role: 'planner' };
  }
  throw new Error(`ask goes to ${ASK_ROUTE_KEYWORDS.join(' or ')}, a project ({project} or {project, agent}), or another task's planner ({task, role: "planner"}); a task reference is for tell`);
}

const sameAskTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Resolve a `tell` recipient. A keyword names this task's counterpart (`worker` or
 * `reviewer`), its planner ladder (`planner`); a task reference names that task's
 * role (default worker); an object names a project or one of its agents.
 */
export function normalizeTellTarget(to, role) {
  if (to === undefined) throw new Error('tell requires to: reviewer, worker, planner, a task reference, {project} or {project, agent}');
  if (typeof to === 'string' && TELL_ROLE_KEYWORDS.includes(to)) {
    if (role !== undefined) throw new Error(`role names a task reference's role; ${to} already names its recipient`);
    return to === 'planner' ? { kind: 'planner' } : { kind: 'counterpart', role: to };
  }
  if (typeof to === 'string') return { kind: 'task', task: to, role: role ?? 'worker' };
  if ('project' in to) {
    if (role !== undefined) throw new Error('role applies to a task reference, not a project');
    return { kind: 'project', project: to.project, agent: to.agent ?? null };
  }
  if (role !== undefined && to.role !== undefined && to.role !== role)
    throw new Error('tell names one role: pass role or the target role, not both with different values');
  return { kind: 'task', task: to.task, role: to.role ?? role ?? 'worker' };
}
