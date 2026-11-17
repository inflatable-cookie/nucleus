// Stable CLI transport front door; each host interprets only its own identity.
import { queueClient, hostCallerIdentity as paseoCallerIdentity } from '../hosts/paseo/cli/index.mjs';
import { t3codeCallerIdentity } from '../hosts/t3code/cli/index.mjs';
import { bbCallerIdentity } from '../shared/host-caller-identity.mjs';

export { queueClient };
export function hostCallerIdentity(env = process.env) {
  return t3codeCallerIdentity(env) ?? bbCallerIdentity(env) ?? paseoCallerIdentity(env);
}
