// One table of per-method caller stamping and pre-send refusals for the CLI.
//
// Every caller-bearing method has exactly one rule here: the method it applies
// to, the refusal it enforces before any service request, and the field the
// authenticated calling thread is written to. The front door (queue-cli.mjs)
// loads one payload, runs this table once, and dispatches; no per-method
// if-block lives beside the dispatch any more, so a new owner verb adds a row
// instead of a copy of the stamping.
//
// A rule never invents an identity: `context.callingThread()` resolves it from
// this run's ticket or the host, and `context.callingThreadSource()` names that
// same thread's proven host, which travels with the identity it names.
const isRecord = input => Boolean(input) && typeof input === 'object' && !Array.isArray(input);

function requireRecord(input, method, shape) {
  if (!isRecord(input)) throw new Error(`CLI ${method} takes ${shape}`);
  return input;
}

function requireNote(input, message) {
  if (typeof input.note !== 'string' || !input.note.trim()) throw new Error(message);
}

function requireReason(input, message) {
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error(message);
}

function requireRelayed(input, message) {
  if (input.relayed !== true) throw new Error(message);
}

/** Write the calling thread into the field the method binds it to. */
async function stamp(input, field, context) {
  input[field] = await context.callingThread();
  return input;
}

/** Write the calling thread and the proven host of that same identity. */
async function stampWithIdentitySource(input, field, context, sourceField = 'identitySource') {
  input[field] = await context.callingThread();
  const identitySource = await context.callingThreadSource(input[field]);
  if (identitySource) input[sourceField] = identitySource;
  return input;
}

const PROMOTION_METHODS = ['lead.submit', 'lead.promote-task', 'papercut.promote-task'];
const TASK_METHODS = ['task', 'queue.task'];
const isTaskMethod = method => TASK_METHODS.includes(method);

/** Rules run in this order, and only the rows that match the method and payload apply. */
export const STAMPING_RULES = [
  // Board promotion is always an agent act relayed with the operator's note.
  {
    matches: (method, input) => PROMOTION_METHODS.includes(method) && isRecord(input),
    apply: async (input, context) => {
      if (input.board) throw new Error('CLI promotion must identify the agent and cannot claim board approval');
      requireNote(input, 'CLI task promotion requires an agent and operator authorization note');
      await stampWithIdentitySource(input, 'agent', context);
      return input;
    },
  },
  // The registry binds the calling thread's worktree; a typed caller is overwritten.
  {
    matches: (method, input) => method === 'task.register' && isRecord(input),
    apply: async (input, context) => stamp(input, 'caller', context),
  },
  // Task 1110: a thread registers itself from its Nucleus ticket.
  {
    matches: (method, input) => method === 'agent.register' && isRecord(input),
    apply: async (input, context) => {
      if (input.agentId !== undefined) throw new Error('CLI agent.register registers the calling thread; register another thread from the board');
      return stamp(input, 'caller', context);
    },
  },
  {
    matches: (method, input) => method === 'agent.unregister' && isRecord(input),
    apply: async (input, context) => stamp(input, 'caller', context),
  },
  // Spec 050: the CLI verb name reads what steers the task; a typed caller is not part of the read.
  {
    matches: method => method === 'task.next',
    apply: async input => {
      if (isRecord(input)) delete input.caller;
      return input;
    },
  },
  // Routing and exclusion are operator acts, relayed by the calling thread; a
  // critical-only set_routing carries no routing change and needs no note.
  {
    matches: (method, input) => isTaskMethod(method) && isRecord(input) && ['set_routing', 'exclude_worker'].includes(input.action),
    apply: async input => {
      const routingOnly = input.action === 'set_routing' && input.critical !== undefined
        && !['scope', 'complexity', 'preferredProfileId', 'requirePreferred', 'thinkingOptionId', 'profileRequests'].some(key => input[key] !== undefined);
      if (routingOnly) return input;
      if (typeof input.note !== 'string' || !input.note.trim()) throw new Error(`CLI ${input.action} requires a note naming operator authorization`);
      input.relayed = true;
      return input;
    },
  },
  // Spec 040: a hold is a reason and an owner for every caller, and the owner is the calling thread.
  {
    matches: (method, input) => isTaskMethod(method) && isRecord(input) && ['hold', 'keep_hold'].includes(input.action),
    apply: async (input, context) => {
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error(`CLI ${input.action} requires a reason`);
      return stamp(input, 'agentId', context);
    },
  },
  // Spec 050: a completion is recorded against the calling thread and carries a reason.
  {
    matches: (method, input) => isTaskMethod(method) && isRecord(input) && input.action === 'complete',
    apply: async (input, context) => {
      await stamp(input, 'caller', context);
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('CLI complete requires a reason');
      return input;
    },
  },
  // Receipt acceptance is relayed and quoting the operator's authorization.
  {
    matches: (method, input) => isTaskMethod(method) && isRecord(input) && input.action === 'accept_receipt',
    apply: async (input, context) => {
      if (!input.relayed || !input.note?.trim()) throw new Error('CLI receipt acceptance requires the relaying thread and an operator authorization note');
      return stamp(input, 'caller', context);
    },
  },
  // Spec 050: every owner control rides the calling thread for the audit event.
  {
    matches: (method, input) => isTaskMethod(method) && isRecord(input),
    apply: async (input, context) => stamp(input, 'caller', context),
  },
  // Spec 056: a re-key is an operator act; the CLI never invents its idempotency key.
  {
    matches: method => method === 'repository.rekey',
    apply: async (input, context) => {
      requireRecord(input, 'repository.rekey', '{source, target, expectedSourceRevision, reason, idempotencyKey}');
      requireReason(input, 'CLI repository.rekey requires a reason quoting the operator authorization');
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new Error('CLI repository.rekey requires the caller\'s idempotencyKey');
      input.author ??= 'operator';
      input.relayedBy = await context.callingThread();
      return input;
    },
  },
  // Task 1183: a board decision is asked by the authenticated calling thread, never a typed name.
  {
    matches: method => method === 'decision.add',
    apply: async (input, context) => {
      requireRecord(input, 'decision.add', '{question, ...}');
      return stamp(input, 'askedBy', context);
    },
  },
  // Task 1183: the replacement decision is asked by the superseding thread, which is its author too.
  {
    matches: method => method === 'decision.supersede',
    apply: async (input, context) => {
      requireRecord(input, 'decision.supersede', '{id, version, ...}');
      await stamp(input, 'askedBy', context);
      input.by = input.askedBy;
      return input;
    },
  },
  {
    matches: method => method === 'decision.answer',
    apply: async (input, context) => {
      if (!isRecord(input) || input.relayed === false || ['operator (board)', 'operator'].includes(input.answeredBy))
        throw new Error('CLI decision.answer must identify the relaying agent and be relayed');
      input.relayed = true;
      if (!input.note?.trim()) throw new Error('CLI decision.answer requires a note quoting the operator authorization');
      return stamp(input, 'answeredBy', context);
    },
  },
  // A routing grant is requested by the calling thread; only the board revokes.
  {
    matches: (method, input) => (method === 'queue.routing-grant' || method === 'routing-grant') && isRecord(input),
    apply: async (input, context) => {
      if (input.action === 'revoke' || ['operator (board)', 'operator'].includes(input.caller))
        throw new Error('CLI cannot revoke a routing grant or claim the operator board; revoke from the board');
      return stamp(input, 'caller', context);
    },
  },
  // QA is submitted by the calling thread, with the request id the retry contract needs.
  {
    matches: (method, input) => method === 'project.qa.run' && isRecord(input),
    apply: async (input, context) => {
      input.requestId ??= context.newRequestId();
      input.submitterAgentId = await context.callingThread();
      context.onQaRequestId?.(input.requestId);
      return input;
    },
  },
  // Spec 058 (task 540): the planner names itself, or the operator names one; the caller is the setter.
  {
    matches: method => method === 'project.set-planner',
    apply: async (input, context) => {
      requireRecord(input, 'project.set-planner', '{key, agentId}');
      return stamp(input, 'setBy', context);
    },
  },
  {
    matches: method => method === 'lead.approve',
    apply: async (input, context) => {
      if (!isRecord(input) || input.relayed === false || input.approver === 'operator (board)')
        throw new Error('CLI lead approval must identify the agent and be relayed');
      input.relayed = true;
      return stamp(input, 'approver', context);
    },
  },
];

/**
 * Stamp one method's payload. A rule may answer the call itself (a run ticket
 * that carries no participant identity answers a question over its own
 * callback); that answer is returned as `early` for the front door to print.
 */
export async function stampInput({ method, input, context }) {
  if (method === 'question.answer') return await answerQuestion(input, context);
  for (const rule of STAMPING_RULES) {
    if (!rule.matches(method, input)) continue;
    const stamped = await rule.apply(input, context);
    if (stamped !== undefined) return { input: stamped };
  }
  return { input };
}

/**
 * A question is answered by the calling thread. A run ticket that carries no
 * participant identity has no caller to resolve, so the answer rides the same
 * authenticated callback the run reports through, content-addressed so an
 * identical retry joins the same answer.
 */
async function answerQuestion(input, context) {
  requireRecord(input, 'question.answer', '{questionId, answer or choice, reason}');
  const identity = context.callerSource();
  if (identity.source !== 'ticket') return { input: await stampWithIdentitySource(input, 'caller', context) };
  const ticket = context.readTicket();
  if (ticket?.participantId) return { input: await stampWithIdentitySource(input, 'caller', context) };
  context.credentialFor(ticket, 'question.answer');
  if (typeof input.questionId !== 'string' || !input.questionId.trim())
    throw new Error('CLI question.answer with a run ticket takes {questionId, answer or choice, reason}');
  const payload = {
    taskId: ticket.taskId, runId: ticket.runId, questionId: input.questionId,
    answer: input.answer, choice: input.choice, reason: input.reason,
    decision: input.decision, overtakes: input.overtakes,
  };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  return { early: await context.answerThroughTicket(ticket, payload) };
}
