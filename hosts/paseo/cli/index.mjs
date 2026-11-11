import { compiledIdentity } from '../../../shared/runtime.mjs';
import { dataHome } from "../../../shared/data-home.mjs";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginCatalogId } from '../../../shared/plugin-discovery.mjs';

/** One connection per command/batch; no automatic cross-transport replay. */
export async function queueClient({ viaPaseo = false, dataDir, rollWaitMs, onProgress, paseoClient } = {}) {
  if (!viaPaseo) {
    if (!compiledIdentity) await import('tsx');
    const { localQueueClient } = await import('../../../shared/service/local-client.ts');
    return localQueueClient(dataDir, { compatibilityWaitMs: rollWaitMs, onProgress });
  }
  let client = paseoClient;
  if (!client) {
    const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
    const settings = JSON.parse(readFileSync(join(dataHome(), 'settings.json'), 'utf8'));
    client = new DaemonClient({ url: settings.daemonUrl, password: settings.password, clientId: 'nucleus-cli', appVersion: '0.8.0', connectTimeoutMs: 5000, reconnect: { enabled: false } });
  }
  let pluginId;
  return { connect: async () => { await client.connect(); pluginId = pluginCatalogId(await client.getPluginCatalog()); }, close: () => client.close(), request: (method, input) => {
    if (!pluginId) throw Error('Connect before calling the Nucleus plugin');
    return client.invokePluginRpc(pluginId, method, input);
  } };
}

/** Only this host interprets its calling-thread environment. */
export function hostCallerIdentity(env = process.env) {
  const nativeAgentId = typeof env.PASEO_AGENT_ID === 'string' ? env.PASEO_AGENT_ID.trim() : '';
  return nativeAgentId ? { hostKind: 'paseo', nativeAgentId } : null;
}
