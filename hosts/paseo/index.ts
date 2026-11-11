import { paseoAdapterClass } from './adapter/paseo';
import type { HostPolicyConstructor } from '../../core/host';
import type { Adapter } from '../../core/host';
import type { RegistrationAdapter } from '../../core/host';

/** Composition root for the first host. */
export function createHost(Policy: HostPolicyConstructor, url: string, socketPath: string, helperPath: string, password?: string, mcpScriptPath?: string): Adapter & RegistrationAdapter & { setAdmissionLaunchEnv(env: Record<string, string> | null): void } {
  const PaseoAdapter = paseoAdapterClass(Policy);
  return new PaseoAdapter(url, socketPath, helperPath, password, mcpScriptPath);
}

/** Preserve the legacy fixture connection seam without exposing the native client to core. */
export function hostConnected(adapter: Adapter): boolean {
  return Boolean((adapter as unknown as { client?: { isConnected?: boolean } }).client?.isConnected);
}

/** Refresh requires the original connection surface, including its failure behavior. */
export function hostConnectionRequired(adapter: Adapter): boolean {
  return (adapter as unknown as { client: { isConnected: boolean } }).client.isConnected;
}

// Public host entry, including the compatibility surface used by fixtures.
export * from "./adapter/paseo";

export { paseoHome, paseoHomeOverride, paseoHomeEnvironment } from './environment.mjs';
