import { callerSource, resolveCaller } from '../shared/caller.mjs';
import { hostCallerIdentity, queueClient } from './queue-client.mjs';

export const cliCallerSource = (env = process.env) => callerSource(env, hostCallerIdentity);

/** The host contributes environment interpretation; the service proves its registered host. */
export function resolveCliCaller({ viaPaseo = false, source } = {}) {
  return resolveCaller({ hostIdentity: hostCallerIdentity, source, resolveHost: async input => {
    const client = await queueClient({ viaPaseo });
    try {
      await client.connect();
      return await client.request('caller.resolve', input);
    } finally { await client.close(); }
  } });
}
