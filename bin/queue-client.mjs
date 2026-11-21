// Stable CLI transport front door; each host interprets only its own identity.
//
// The default is the neutral client owner's direct service transport, which
// owns the connection, the compiled/source load and the roll wait. Only an
// explicit `--via-paseo` reaches the Paseo adapter's bridge, and nothing here
// falls back from one transport to the other or replays a request.
import { compiledIdentity } from '../shared/runtime.mjs';
import { hostCallerIdentity as paseoCallerIdentity, paseoBridgeQueueClient } from '../hosts/paseo/cli/index.mjs';
import { t3codeCallerIdentity } from '../hosts/t3code/cli/index.mjs';
import { bbCallerIdentity } from '../shared/host-caller-identity.mjs';

export async function queueClient({ viaPaseo = false, ...options } = {}) {
  if (viaPaseo) return paseoBridgeQueueClient(options);
  if (!compiledIdentity) await import('tsx');
  const { queueClient: directQueueClient } = await import('../shared/service/local-client.ts');
  return directQueueClient(options);
}

export function hostCallerIdentity(env = process.env) {
  return t3codeCallerIdentity(env) ?? bbCallerIdentity(env) ?? paseoCallerIdentity(env);
}
