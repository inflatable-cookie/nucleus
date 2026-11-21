import { dataHome } from '../../../shared/data-home.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginCatalogId } from './plugin-catalog.mjs';

export const DEFAULT_PASEO_DAEMON_URL = 'ws://127.0.0.1:6767/ws';

/** Resolve the explicit Paseo bridge daemon URL, falling back to Paseo's default endpoint on fresh installs. */
export function paseoDaemonUrl(settings) {
  return typeof settings?.daemonUrl === 'string' && settings.daemonUrl.trim()
    ? settings.daemonUrl
    : DEFAULT_PASEO_DAEMON_URL;
}

/**
 * The explicit `--via-paseo` bridge only. The default CLI transport is the
 * neutral client owner (`shared/service/local-client.ts` `queueClient`), which
 * this host neither wraps nor falls back from.
 *
 * One connection per command/batch; no automatic cross-transport replay.
 */
export async function paseoBridgeQueueClient({ paseoClient } = {}) {
  let client = paseoClient;
  if (!client) {
    const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
    const settingsPath = join(dataHome(), 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    client = new DaemonClient({ url: paseoDaemonUrl(settings), password: settings.password, clientId: 'nucleus-cli', appVersion: '0.8.0', connectTimeoutMs: 5000, reconnect: { enabled: false } });
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
