#!/usr/bin/env node
// `nucleus ask` and `nucleus tell`: the helper form of the agent verbs (shared/agent-verbs) for
// hosts without an MCP binding. Same arguments, same result, same routes as the `ask` and `tell`
// MCP tools. The caller is proven by its ticket or host identity before anything is sent; the
// payload names a recipient, never an agent or thread ID.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readPayload } from './payload.mjs';
import { callbackRequest } from '../shared/service/callback-client.mjs';
import { cliCallerSource, resolveCliCaller } from './caller.mjs';

/** The in-turn budget `ask` waits (120s) plus the callback margin the MCP binding also uses. */
const ASK_CALLBACK_TIMEOUT_MS = 150_000;
const TELL_CALLBACK_TIMEOUT_MS = 45_000;
const VERBS = Object.freeze({
  ask: { route: '/ask', timeoutMs: ASK_CALLBACK_TIMEOUT_MS, timeoutMessage: 'Callback timed out; retry the same JSON to collect the question. Never re-ask as a new question.' },
  tell: { route: '/message', timeoutMs: TELL_CALLBACK_TIMEOUT_MS, timeoutMessage: 'Message timed out; retry the same JSON' },
});

/** The run ticket this process was launched with, read only after the resolver accepted it. */
function ticketOf(path) {
  const ticket = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof ticket.socketPath !== 'string' || !ticket.socketPath || typeof ticket.token !== 'string' || !ticket.token)
    throw new Error('The Nucleus caller ticket is incomplete');
  return ticket;
}

/**
 * Send one agent verb. The identity is proven first (`resolveCliCaller`); the request then
 * carries only the resolved ticket identity, so a payload can never name another run or participant.
 */
async function runAgentVerb(verb, payload, env = process.env) {
  const spec = VERBS[verb];
  if (!spec) throw new Error(`Choose a verb: nucleus ask or nucleus tell`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`nucleus ${verb} takes a JSON object`);
  const source = cliCallerSource(env);
  const identity = await resolveCliCaller({ source });
  const ticketPath = source.source === 'ticket' ? source.path : identity.participantTicket;
  if (!ticketPath) throw new Error(`nucleus ${verb} needs a Nucleus ticket; this thread has no participant role, so nothing was sent`);
  const ticket = ticketOf(ticketPath);
  // A planner or named agent answers questions with question.answer; it never asks. Refused before any service request.
  if (ticket.participantId && verb === 'ask')
    throw new Error('ask is a worker\'s and reviewer\'s verb; a planner answers a question with question.answer, and tells with nucleus tell');
  const { runId, ...request } = payload;
  // The resolver proves the identity; the request never names a different run than the ticket holds.
  if (runId !== undefined && ticket.runId !== undefined && runId !== ticket.runId)
    throw new Error(`Run ${runId} is not this session's run; nothing was sent`);
  const identityFields = ticket.participantId
    ? { participantId: ticket.participantId }
    : { taskId: ticket.taskId, runId: ticket.runId };
  if (!ticket.participantId && (typeof ticket.taskId !== 'string' || typeof ticket.runId !== 'string'))
    throw new Error('The Nucleus run ticket is incomplete; nothing was sent');
  const body = { ...request, ...identityFields };
  const eventId = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const result = await callbackRequest(ticket, spec.route, { eventId, ...body }, { timeoutMs: spec.timeoutMs, timeoutMessage: spec.timeoutMessage });
  return { caller: identity.caller, result };
}

// Loaded only by `nucleus ask` / `nucleus tell` (bin/nucleus.mjs) and run directly by the tests.
{
  const [verb, ...rest] = process.argv.slice(2);
  try {
    const file = rest.find(arg => arg !== '--wait');
    const { result } = await runAgentVerb(verb, readPayload(file));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
