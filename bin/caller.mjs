import { callerSource, resolveCaller } from '../shared/caller.mjs';
import { hostCallerIdentity, queueClient } from './queue-client.mjs';

export const cliCallerSource = (env = process.env) => callerSource(env, hostCallerIdentity);

/** The host contributes environment interpretation; the service proves its registered host. */
export async function resolveCliCaller({ viaPaseo = false, source } = {}) {
  const identity = await resolveOnce({ viaPaseo, source });
  // A registered planner receives its participant ticket in the response to its
  // own call; nested Nucleus calls from this thread inherit it rather than
  // needing a message into the thread.
  if (identity.participantTicket && !process.env.NUCLEUS_TICKET) process.env.NUCLEUS_TICKET = identity.participantTicket;
  return identity;
}

function resolveOnce({ viaPaseo = false, source } = {}) {
  return resolveCaller({ hostIdentity: hostCallerIdentity, source, resolveHost: async input => {
    const client = await queueClient({ viaPaseo });
    try {
      await client.connect();
      return await client.request('caller.resolve', input);
    } finally { await client.close(); }
  } });
}
