import { callerSource, resolveCaller } from '../shared/caller.mjs';
import { hostCallerIdentity, queueClient } from './queue-client.mjs';

export const cliCallerSource = (env = process.env) => callerSource(env, hostCallerIdentity);

/** The host contributes environment interpretation; the service proves its registered host. */
export async function resolveCliCaller({ viaPaseo = false, source } = {}) {
  const identity = await resolveOnce({ viaPaseo, source });
  // Current run ticket first, then a participant ticket. Nested Nucleus calls
  // from this thread inherit it rather than needing a message into the thread.
  if (!process.env.NUCLEUS_TICKET) {
    if (identity.runTicket) process.env.NUCLEUS_TICKET = identity.runTicket;
    else if (identity.participantTicket) process.env.NUCLEUS_TICKET = identity.participantTicket;
  }
  return identity;
}

function resolveOnce({ viaPaseo = false, source } = {}) {
  return resolveCaller({ hostIdentity: hostCallerIdentity, source, resolveHost: async input => {
    const client = await queueClient({ viaPaseo });
    try {
      await client.connect();
      return await client.request('caller.resolve', input, 10_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) throw new Error('The host is slow; retry', { cause: error });
      throw error;
    } finally { await client.close(); }
  } });
}
