/**
 * Nucleus's BB plugin backend (Spec 062, phase 0).
 *
 * This is the transport skeleton, not the adapter: it declares a service channel
 * role, executes the bounded host operations the service asks for, and nothing
 * else. It registers no host, adds no host kind, contributes no UI and cannot
 * dispatch a task. The Nucleus skill and the routing that selects BB per
 * repository are later phases.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runHostChannel } from "./channel";
import { createHostOperations, type BbHostSdk } from "./operations";

/** The plugin SDK this build was written against. A diagnostic, never an allowlist. */
export const BB_PLUGIN_SDK_VERSION = "0.6.132";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`nucleus host executor loaded (plugin SDK ${BB_PLUGIN_SDK_VERSION})`);

  // The Nucleus data home whose `queue-service.json` names the socket and
  // credential. One setting, not a copy of Nucleus's configuration: the service
  // stays the owner of its own identity.
  const settings = bb.settings.define({
    serviceDataDir: {
      type: "string",
      label: "Nucleus data directory",
      description: "The Nucleus data home holding queue-service.json. The plugin connects out to that service and executes host operations for this BB server.",
      default: "",
    },
  });

  const declarations = {
    dataDir: () => (bb.server as unknown as { experimental_dataDir: string }).experimental_dataDir,
    version: null as string | null,
  };

  async function bbVersion(): Promise<string> {
    if (declarations.version) return declarations.version;
    try {
      const version = await (bb.sdk as unknown as BbHostSdk).system.version();
      declarations.version = String(version.currentVersion ?? "unknown");
    } catch {
      declarations.version = "unknown";
    }
    return declarations.version;
  }

  const operations = createHostOperations({
    sdk: bb.sdk as unknown as BbHostSdk,
    pluginId: "nucleus",
    sdkVersion: BB_PLUGIN_SDK_VERSION,
    dataDir: declarations.dataDir,
  });

  // Metadata names the helper route; it carries no reporting credential and grants
  // no authority. The run ticket authenticates every helper request.
  bb.agents.configure(context => {
    const meta = context.pluginMetadata.nucleus;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { tools: [], skills: [] };
    const binding = meta as Record<string, unknown>;
    if (!["task", "run", "host", "helperPath", "ticketPath"].every(key => typeof binding[key] === "string")) return { tools: [], skills: [] };
    return { tools: [], skills: [], instructions: `Nucleus reporting binding (data): ${JSON.stringify(binding)}. Report through the helper and ticket named in your run prompt.` };
  });

  await settings.get();

  // A long-lived service: it starts after load and receives an AbortSignal on
  // reload, disable and shutdown. Its sleeps wake on abort, so a reload does not
  // wait out a backoff window.
  bb.background.service("nucleus-host-channel", {
    async start(signal) {
      const { serviceDataDir } = await settings.get();
      // One read of the BB version up front: the declaration names it, and a BB that
      // cannot answer is a diagnostic, never a reason to refuse the role.
      await bbVersion();
      if (!serviceDataDir) {
        bb.log.warn("Nucleus data directory is not configured; the host-operation channel waits for configuration");
        await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); });
        return;
      }
      await runHostChannel({
        serviceDataDir,
        operations,
        log: { info: message => bb.log.info(message), warn: message => bb.log.warn(message), error: message => bb.log.error(message) },
        signal,
        declaration: () => ({ dataDir: declarations.dataDir(), bbVersion: declarations.version ?? "unknown", sdkVersion: BB_PLUGIN_SDK_VERSION }),
      });
    },
  });

  bb.onDispose(() => { bb.log.info("nucleus host executor disposed"); });
}
