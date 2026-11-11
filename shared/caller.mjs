import { existsSync, readFileSync } from 'node:fs';
import { callbackRequest } from './service/callback-client.mjs';

/** Select a source without reading another thread's ticket or falling past a refused ticket. */
export function callerSource(env = process.env, hostIdentity = () => null) {
  const path = typeof env.NUCLEUS_TICKET === 'string' ? env.NUCLEUS_TICKET.trim() : '';
  if (path && existsSync(path)) return { source: 'ticket', path };
  const host = hostIdentity(env);
  if (host) return { source: 'host', ...host };
  throw new Error('CLI records the calling thread; no caller identity found. Tried: Nucleus run or participant ticket (NUCLEUS_TICKET), host-supplied identity');
}

/** One ticket-first caller resolver for every CLI and helper. No credential enters a regular RPC payload. */
export async function resolveCaller({ env = process.env, hostIdentity, resolveHost, source } = {}) {
  const selected = source ?? callerSource(env, hostIdentity);
  if (selected.source === 'host') {
    if (!resolveHost) throw new Error('Host caller resolution is unavailable');
    return resolveHost({ hostKind: selected.hostKind, nativeAgentId: selected.nativeAgentId });
  }
  const ticket = JSON.parse(readFileSync(selected.path, 'utf8'));
  if (typeof ticket.socketPath !== 'string' || !ticket.socketPath || typeof ticket.token !== 'string' || !ticket.token)
    throw new Error('The Nucleus caller ticket is incomplete');
  const payload = typeof ticket.participantId === 'string' && ticket.participantId
    ? { participantId: ticket.participantId }
    : typeof ticket.taskId === 'string' && ticket.taskId && typeof ticket.runId === 'string' && ticket.runId
      ? { taskId: ticket.taskId, runId: ticket.runId } : null;
  if (!payload) throw new Error('The Nucleus caller ticket is incomplete');
  const result = await callbackRequest(ticket, '/caller', payload, { timeoutMs: 45000, timeoutMessage: 'Caller identity resolution timed out' });
  if (typeof result.caller !== 'string' || !result.caller || typeof result.hostId !== 'string' || !result.hostId ||
      !['run-ticket', 'participant-ticket'].includes(result.source)) throw new Error('Invalid Nucleus caller identity response');
  return result;
}
