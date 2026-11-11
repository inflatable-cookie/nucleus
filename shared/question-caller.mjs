import { existsSync } from 'node:fs';

/**
 * Ticket-first caller identity for `question.answer`. Any host can answer with
 * a run ticket; PASEO_AGENT_ID remains the fallback until a follow-up moves
 * the rest of the CLI onto this resolver. A named ticket path that is gone
 * (released runs purge their launch tickets) is not a source.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ source: 'ticket', path: string } | { source: 'agent', caller: string }}
 */
export function resolveQuestionAnswerCaller(env = process.env) {
  const ticket = typeof env.NUCLEUS_TICKET === 'string' ? env.NUCLEUS_TICKET.trim() : '';
  if (ticket && existsSync(ticket)) return { source: 'ticket', path: ticket };
  const caller = typeof env.PASEO_AGENT_ID === 'string' ? env.PASEO_AGENT_ID.trim() : '';
  if (caller) return { source: 'agent', caller };
  throw new Error('CLI question.answer records the calling thread; a run ticket or PASEO_AGENT_ID is required');
}
