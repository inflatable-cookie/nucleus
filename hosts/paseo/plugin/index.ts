import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType } from "zod";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { RPC_CATALOGUE } from "../../../shared/rpc-catalogue";
import { type LifecycleSignalKind } from "../../../shared/lifecycle-signal";
import * as contracts from "../../../shared/contracts";
import { bridgeProcessActions } from "../../../service/install/bridge-process-actions";
import { ServiceBridge } from "./bridge";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin forwarding-only backend bridge (Contract 007). Every handler validates
 * its end with the shared contract and forwards the exact catalogue method to
 * the local standalone service. The bridge imports no Store, engine, Git, hook
 * or routing module, opens no Queue state file and never starts an in-plugin
 * fallback runtime.
 */
type AnyRpcContract = PluginRpcContract<ZodType<unknown, unknown>, ZodType<unknown, unknown>>;

/** Bounded identity a Paseo lifecycle event carries; no event payload is forwarded. */
interface LifecycleHintEvent {
  agent?: { id: string; workspaceId: string | null } | null;
  workspace?: { id: string } | null;
}

/** The Paseo CLI: `PASEO_CLI`, else its default install path, else whatever `paseo` is on PATH. */
function pluginReloadCommand(pluginId: string) {
  const installed = join(homedir(), ".local", "bin", "paseo");
  const command = process.env.PASEO_CLI || (existsSync(installed) ? installed : "paseo");
  return { command, args: ["plugin", "reload", pluginId] };
}

export default function contribute(server: PluginServerContext) {
  // Discovery knows only `nucleus` (nucleus#971); a Paseo config that still names
  // the retired `northstar-queue` ID is ignored, not migrated.
  const pluginId = "nucleus";
  // A landed roll reloads this plugin so the bridge and UI match the new service.
  const bridge = new ServiceBridge({ processActions: bridgeProcessActions, reloadPluginCommand: () => pluginReloadCommand(pluginId) });
  // Reload adopts a compatible service; cold startup must not depend on opening
  // the board or receiving the first forwarded RPC. Bootstrap is bounded and
  // reports its failure through service-state without blocking registration.
  void bridge.serviceState();
  // A merge that changes the checkout's backend source rolls the service after a
  // passing typecheck; the plugin itself (bridge and UI) waits for a reload.
  bridge.watch();
  for (const entry of RPC_CATALOGUE) {
    server.handle(entry.contract as AnyRpcContract, input => bridge.forward(entry, input));
  }
  server.handle(contracts.serviceState as AnyRpcContract, () => bridge.serviceState());
  /**
   * Forward only bounded agent/workspace lifecycle hints. A hint carries the
   * event name and identity, never a turn, permission, timeline or workspace
   * payload, and it is best-effort: the service maps it to Queue identities it
   * already knows and signals nothing for an unknown identity. Durable Queue
   * facts, exact observations and the bounded safety sweep stay authoritative.
   */
  const hint = (kind: LifecycleSignalKind, event: LifecycleHintEvent) => {
    const agentId = event.agent?.id ?? null;
    const workspaceId = event.agent?.workspaceId ?? event.workspace?.id ?? null;
    if (!agentId && !workspaceId) return;
    void bridge.signal({ kind, agentId, workspaceId, at: new Date().toISOString() });
  };
  server.on("agent.created", event => hint("agent.created", event));
  server.on("agent.turn_started", event => hint("agent.turn_started", event));
  server.on("agent.turn_ended", event => hint("agent.turn_ended", event));
  server.on("agent.permission_requested", event => hint("agent.permission_requested", event));
  server.on("agent.permission_resolved", event => hint("agent.permission_resolved", event));
  server.on("agent.archived", event => hint("agent.archived", event));
  server.on("workspace.created", event => hint("workspace.created", event));
  server.on("workspace.archived", event => hint("workspace.archived", event));
  return () => bridge.close();
}
