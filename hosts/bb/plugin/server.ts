/**
 * Nucleus's BB plugin backend (Spec 062, phases 0–5).
 *
 * Keeps the reverse service channel, executes bounded BB host operations, supplies
 * helper-reporting bindings from run metadata, and composes the vendored thread
 * list's own server entry so the forked sidebar has its preference store. Host
 * registration, repository routing and task lifecycle remain service-owned.
 * Phase 6 adds the board's forwarding call, BB's lifecycle events as bounded hints,
 * and `bb nucleus terminal` (`board-bridge.ts`).
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { realpathSync } from "node:fs";
import { runHostChannel, type HostChannelClient } from "./channel";
import { createHostOperations, type BbHostSdk } from "./operations";
import { readNucleusBuild } from "./build-identity";
import threadListPlugin from "./sidebar/server.js";
import {
  BOARD_SIGNAL_CHANNEL,
  createSidebarGroupsService,
  createSidebarTaskActionService,
  sidebarGroupsContract,
  sidebarTaskActionContract,
} from "./sidebar-groups";
import {
  BB_LIFECYCLE_HINTS,
  boardContract,
  createBoardBridge,
  forwardLifecycleHint,
  withTerminalCommand,
  type BbLifecycleEvent,
  type CliRegistration,
  type TerminalCreateSdk,
} from "./board-bridge";

/** The plugin SDK this build was written against. A diagnostic, never an allowlist. */
export const BB_PLUGIN_SDK_VERSION = "0.6.132";

/**
 * How often the backend reads the service's board revision to publish a change
 * (Spec 062, decision 5b). One bounded read on the retained connection; the
 * sidebar refetches its own read only when the revision moves.
 */
const BOARD_SIGNAL_POLL_MS = 2_000;

/**
 * Watch the service's board revision and publish it as one realtime signal.
 *
 * The first read only records the current revision: a sidebar that has just
 * mounted already fetched, so an immediate signal would refetch it for nothing.
 * Afterwards every move is published, and a failed read is retried on the next
 * tick — a missing signal delays a header, it never blocks the sidebar.
 */
export function watchBoardSignal(bb: BbPluginApi, client: HostChannelClient): () => void {
  let revision: number | null = null;
  let stopped = false;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    let answer: unknown;
    try {
      answer = await client.request("queue.ui-snapshot", revision === null ? {} : { revision });
    } catch {
      return;
    }
    if (stopped) return;
    const next = (answer as { revision?: unknown } | null)?.revision;
    if (typeof next !== "number" || next === revision) return;
    const first = revision === null;
    revision = next;
    if (!first) bb.realtime.publish(BOARD_SIGNAL_CHANNEL, { revision: next });
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, BOARD_SIGNAL_POLL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`nucleus host executor loaded (plugin SDK ${BB_PLUGIN_SDK_VERSION})`);
  // The Nucleus build this package came from (Spec 062, phase 7). A packaged plugin
  // declares it, so the service can refuse a plugin from another build by name; a
  // checkout install carries none and is what the private proofs install.
  const nucleusBuild = readNucleusBuild(import.meta.url);
  bb.log.info(
    nucleusBuild
      ? `nucleus plugin build ${nucleusBuild.slice(0, 12)} (pinned to the service build)`
      : "nucleus plugin built from a source checkout; the service build pin reads this install as unpinned",
  );

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

  // Spec 062 decision 5a: this backend composes the vendored list's own server
  // entry with the adapter's RPC catalogue and the presence socket. One plugin,
  // one connection, one catalogue — and the forked list's preference store, its
  // `listPreferences`/`setPreference`/`resetPreference` RPC and its `prefs` CLI
  // register here, so `PreferencesSync` can hydrate and the list leaves its
  // loading skeleton. Without this call the vendored server entry is dead code and
  // every Nucleus task group renders without its collapse preference.
  //
  // BB takes one CLI registration per plugin, so the list's `prefs` registration is
  // captured here and registered once with `terminal` beside it (phase 6). Every
  // other surface the list touches is the real API.
  let vendoredCli: CliRegistration | null = null;
  const listApi = new Proxy(bb, {
    get(target, property) {
      if (property === "cli") return { register: (registration: CliRegistration) => { vendoredCli = registration; } };
      return Reflect.get(target, property, target);
    },
  });
  await threadListPlugin(listApi);
  const terminalSdk = () => bb.sdk as unknown as TerminalCreateSdk;
  bb.cli.register(withTerminalCommand(vendoredCli ?? {
    name: bb.pluginId,
    summary: "Nucleus",
    commands: [],
    run: () => ({ exitCode: 2, stderr: "Unknown command. Try `bb nucleus terminal`.\n" }),
  }, terminalSdk) as unknown as Parameters<typeof bb.cli.register>[0]);

  // Metadata names the helper route; it carries no reporting credential and grants
  // no authority. The run ticket authenticates every helper request.
  // The forked sidebar's one read (Spec 062, decision 5b). It is served by this
  // backend and forwarded over the retained connection, so the UI holds no service
  // credential and reads nothing the service does not publish.
  let channelClient: HostChannelClient | null = null;
  // Project rows resolve through BB's own project list too (decision 5d), so a row
  // keeps its board link with no live task workspace: one read per sidebar read.
  const samePath = (left: string, right: string) => {
    const canonical = (value: string) => { try { return realpathSync(value); } catch { return value.replace(/\/+$/, ""); } };
    return canonical(left) === canonical(right);
  };
  bb.rpc.register(sidebarGroupsContract, createSidebarGroupsService(() => channelClient, {
    list: () => (bb.sdk as unknown as { projects: { list(): Promise<unknown> } }).projects.list(),
    samePath,
  }), {
    experimental_description:
      "The forked sidebar's batched Nucleus task-group read: one answer for every group's state line.",
  });
  // The task group's own actions (nucleus#1313): detach names no planner and holds
  // no plugin state, so it is one bounded forward to the service's owner control.
  bb.rpc.register(sidebarTaskActionContract, createSidebarTaskActionService(() => channelClient), {
    experimental_description:
      "The forked sidebar's task-group action: detach a task's presentation from its planner.",
  });
  // Phase 6: the board, its Settings and its pills reach the service catalogue
  // through this one forwarding method, on the same retained connection.
  bb.rpc.register(boardContract, createBoardBridge(() => channelClient), {
    experimental_description:
      "The Nucleus board's catalogue call: forwards one service catalogue method over the plugin's retained connection.",
  });
  // BB's thread events ride the existing bounded lifecycle hint, never a lifecycle write.
  for (const event of Object.keys(BB_LIFECYCLE_HINTS) as BbLifecycleEvent[]) {
    bb.events.on(event, payload => { void forwardLifecycleHint(() => channelClient, event, payload as { thread?: { id?: unknown } }); });
  }

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
        onDeclared: client => {
          channelClient = client;
          const stopSignal = watchBoardSignal(bb, client);
          return () => {
            channelClient = null;
            stopSignal();
          };
        },
        log: { info: message => bb.log.info(message), warn: message => bb.log.warn(message), error: message => bb.log.error(message) },
        signal,
        declaration: () => ({
          dataDir: declarations.dataDir(),
          bbVersion: declarations.version ?? "unknown",
          sdkVersion: BB_PLUGIN_SDK_VERSION,
          ...(nucleusBuild ? { nucleusBuild } : {}),
        }),
      });
    },
  });

  bb.onDispose(() => { bb.log.info("nucleus host executor disposed"); });
}
