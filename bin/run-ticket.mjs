// This run's Nucleus ticket: one owner for selecting, reading and checking it.
//
// A CLI call that acts as the running agent names the thread behind it, and two
// actions (self-force and answering a question with no participant identity) may
// only use the ticket's private credential. Both used to read the ticket, check
// the continuation run and demand the credential in their own copy, and the
// copies disagreed about the refusal. This module reads the ticket once and
// reports a typed record: the credential when the caller needs one, the
// participant identity when it has one, and the durable run identity.
import { readFileSync } from 'node:fs';

/** The ticket this process carries: a continuation ticket wins over the original run ticket. */
export function runTicketPath(env = process.env) {
  const continuation = typeof env.NUCLEUS_CONTINUATION_TICKET === 'string' ? env.NUCLEUS_CONTINUATION_TICKET.trim() : '';
  if (continuation) return continuation;
  return typeof env.NUCLEUS_TICKET === 'string' && env.NUCLEUS_TICKET.trim() ? env.NUCLEUS_TICKET.trim() : null;
}

/** The run a continuation must belong to, or null when this process is not a continuation. */
export function continuationRunId(env = process.env) {
  return typeof env.NUCLEUS_CONTINUATION_RUN_ID === 'string' && env.NUCLEUS_CONTINUATION_RUN_ID.trim()
    ? env.NUCLEUS_CONTINUATION_RUN_ID.trim() : null;
}

/**
 * Read and check this run's ticket. Returns null when the process carries none,
 * and throws when the ticket is a continuation of another run.
 */
export function readRunTicket(env = process.env) {
  const path = runTicketPath(env);
  if (!path) return null;
  const ticket = JSON.parse(readFileSync(path, 'utf8'));
  const expectedRunId = continuationRunId(env);
  if (expectedRunId && ticket.runId !== expectedRunId) {
    throw new Error(`Continuation ticket is for run ${ticket.runId ?? 'unknown'}, not current run ${expectedRunId}; use the ticket path supplied in the continuation prompt`);
  }
  return {
    path, ticket,
    participantId: typeof ticket.participantId === 'string' && ticket.participantId ? ticket.participantId : null,
    taskId: typeof ticket.taskId === 'string' ? ticket.taskId : null,
    runId: typeof ticket.runId === 'string' ? ticket.runId : null,
    credential: typeof ticket.socketPath === 'string' && ticket.socketPath && typeof ticket.token === 'string' && ticket.token
      ? { socketPath: ticket.socketPath, token: ticket.token } : null,
  };
}

/**
 * The ticket's callback credential, for the one action that asks for it. A
 * participant ticket answers through its host identity and has no run of its
 * own to act for, so it is refused here rather than acted for.
 */
export function credentialFor(ticket, purpose) {
  if (!ticket || ticket.participantId || !ticket.credential || !ticket.taskId || !ticket.runId) {
    throw new Error(`The Nucleus run ticket is incomplete; ${purpose} is unavailable`);
  }
  return ticket.credential;
}
