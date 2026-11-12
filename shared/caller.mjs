import { existsSync, readFileSync } from 'node:fs';
import { callbackRequest } from './service/callback-client.mjs';
import { join } from 'node:path';
import { dataHome } from './data-home.mjs';

const CALLER_ROLL_STALE_MS = 15 * 60_000;
const CALLER_ROLL_STAGES = new Set(['replacing', 'retrying']);

/** A ticket callback is pinned to one service, so explain an active roll before using its stale socket. */
export function callerRollProgress(dataDir = dataHome(), now = Date.now()) {
  let roll;
  try { roll = JSON.parse(readFileSync(join(dataDir, 'queue-service-roll.json'), 'utf8')); } catch { return null; }
  if (!CALLER_ROLL_STAGES.has(roll?.status) || typeof roll.at !== 'string') return null;
  const at = Date.parse(roll.at);
  if (!Number.isFinite(at) || now - at >= CALLER_ROLL_STALE_MS) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - at) / 1000));
  return `Nucleus service roll in progress (${roll.status}, ${elapsedSeconds}s elapsed); retry shortly. Caller identity was not resolved, so the requested control was not applied.`;
}

/** Select a source without reading another thread's ticket or falling past a refused ticket. */
export function callerSource(env = process.env, hostIdentity = () => null) {
  const path = typeof env.NUCLEUS_TICKET === 'string' ? env.NUCLEUS_TICKET.trim() : '';
  if (path && existsSync(path)) return { source: 'ticket', path };
  const host = hostIdentity(env);
  if (host) return { source: 'host', ...host };
  throw new Error('CLI records the calling thread; no caller identity found. Tried: Nucleus run or participant ticket (NUCLEUS_TICKET), host-supplied identity');
}

/**
 * The proven host of the identity a request names, for that exact identity only.
 *
 * `resolveCaller` already proved which host the calling thread belongs to (the
 * run or participant ticket, or the host-supplied fallback). A request that
 * names that same thread may carry the pair as its origin identity source, so an
 * offline host with no part in the identity cannot make its origin ambiguous.
 * The pair names one identity: it grants no host to another identity and no
 * authority to run anything anywhere.
 */
export function identitySourceFor(identity, agent) {
  if (!identity || typeof identity.hostId !== 'string' || !identity.hostId) return undefined;
  if (typeof agent !== 'string' || !agent.trim() || identity.caller !== agent) return undefined;
  return { agent, hostId: identity.hostId };
}

/** One ticket-first caller resolver for every CLI and helper. No credential enters a regular RPC payload. */
export async function resolveCaller({ env = process.env, hostIdentity, resolveHost, source } = {}) {
  const selected = source ?? callerSource(env, hostIdentity);
  if (selected.source === 'host') {
    if (!resolveHost) throw new Error('Host caller resolution is unavailable');
    return resolveHost({ hostKind: selected.hostKind, nativeAgentId: selected.nativeAgentId });
  }
  const rollProgress = callerRollProgress(dataHome(env));
  if (rollProgress) throw new Error(rollProgress);
  const ticket = JSON.parse(readFileSync(selected.path, 'utf8'));
  if (typeof ticket.socketPath !== 'string' || !ticket.socketPath || typeof ticket.token !== 'string' || !ticket.token)
    throw new Error('The Nucleus caller ticket is incomplete');
  const payload = typeof ticket.participantId === 'string' && ticket.participantId
    ? { participantId: ticket.participantId }
    : typeof ticket.taskId === 'string' && ticket.taskId && typeof ticket.runId === 'string' && ticket.runId
      ? { taskId: ticket.taskId, runId: ticket.runId } : null;
  if (!payload) throw new Error('The Nucleus caller ticket is incomplete');
  let result;
  try {
    result = await callbackRequest(ticket, '/caller', payload, { timeoutMs: 45000, timeoutMessage: 'Caller identity resolution timed out' });
  } catch (error) {
    const progress = callerRollProgress(dataHome(env));
    if (progress) throw new Error(progress, { cause: error });
    throw error;
  }
  if (typeof result.caller !== 'string' || !result.caller || typeof result.hostId !== 'string' || !result.hostId ||
      !['run-ticket', 'participant-ticket'].includes(result.source)) throw new Error('Invalid Nucleus caller identity response');
  return result;
}
