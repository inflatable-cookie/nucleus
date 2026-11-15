import { paseoAdapterClass } from './adapter/paseo';
import type { HostPolicyConstructor } from '../../core/host';
import type { Adapter } from '../../core/host';
import type { RegistrationAdapter } from '../../core/host';

/** Composition root for the first host. */
export function createHost(Policy: HostPolicyConstructor, url: string, socketPath: string, helperPath: string, password?: string, mcpScriptPath?: string): Adapter & RegistrationAdapter & { setAdmissionLaunchEnv(env: Record<string, string> | null): void } {
  const PaseoAdapter = paseoAdapterClass(Policy);
  return new PaseoAdapter(url, socketPath, helperPath, password, mcpScriptPath);
}

// Public host entry, including the compatibility surface used by fixtures.
export * from "./adapter/paseo";

export { paseoHome, paseoHomeOverride, paseoHomeEnvironment } from './environment.mjs';
