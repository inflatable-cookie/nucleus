import React from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { useRpc, useWorkspace, type PluginButtonContentProps, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { RpcContract } from "../../../shared/rpc";
import { hintSettingsSection } from "../../../client/settings-hint";
import type { BoardAgents, BoardHost, BoardShell, BoardWorkspace } from "../../../client/shell/types";

/**
 * The Paseo shell. With `index.client.tsx`, the only client module that imports
 * the Paseo plugin package; every board component reaches Paseo through here.
 */
export const paseoShell = {
  useRpc,
  useWorkspace<Selection>(workspaceId: string, selector: (workspace: BoardWorkspace) => Selection) {
    return useWorkspace(workspaceId, selector);
  },
  Icon,
} satisfies BoardShell;

/**
 * The board's calls on one plugin installation. `client` is the plugin's client
 * context: rpc, panels, settings and composer pills come from it, and the agent
 * inventory comes from its Paseo client.
 */
export function paseoHost(client: PluginClientContext): BoardHost {
  return {
    rpc<Input extends ZodType, Output extends ZodType>(contract: RpcContract<Input, Output>, input: ZodInput<Input>): Promise<ZodOutput<Output>> {
      return client.rpc(contract, input);
    },
    openPanel: (id, options) => client.openPanel(id, options),
    // Paseo's route takes only the screen id; the section goes ahead as a hint the screen takes.
    openSettings: (id, options) => { if (options?.section) hintSettingsSection(options.section); client.openSettings(id); },
    addComposerPill({ id, workspaceId, agentId, button }) {
      // Paseo hands its popover the host's props (layout, platform); the board's
      // content takes only what it reads, so the wrapper passes the rest through.
      const Content = button.behavior.Content;
      const PopoverContent = (props: PluginButtonContentProps) => <Content {...props} />;
      return client.addComposerPill({
        id, workspaceId, agentId,
        button: { title: button.title, label: button.label, icon: button.icon, behavior: { kind: "popover", Content: PopoverContent } },
      });
    },
    // Read on each use, as the board always did. The 0.9 SDK types lag the Paseo
    // host's agent API; the board reads the host's shapes as BoardAgents and
    // checks optional members at call sites.
    get agents() { return client.paseo.agents as unknown as BoardAgents; },
  };
}
