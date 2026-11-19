/** One permanent, host-owned ACP inbox. It is never a task or a role thread. */
import { config, decode, T3CompatibilityError } from "./contracts";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import type { T3Reads } from "./reads";
import type { T3RpcClient } from "./rpc";
import type { AcpSessionSurface } from "../../shared/acp/surface";
import { HOLD_MARKER, parentPromptRules, PARENT_MODEL, PARENT_PROVIDER } from "./nesting";

interface InboxContext {
  hostId(): string;
  acp(): AcpSessionSurface | null;
  state: T3StateFile;
  reads: T3Reads;
  rpc: T3RpcClient;
  intents: T3IntentLedger;
  boardLink?: () => Promise<string>;
  workspace(directory: string): Promise<{ id: string; projectId: string }>;
}

export class T3Inbox {
  private previewAttempted = false;
  constructor(private readonly core: InboxContext) {}

  async reconcile(): Promise<void> {
    const acp = this.core.acp();
    if (!acp?.bindInbox) return;
    const observed = decode(config, await this.core.rpc.call("server.getConfig", {}), "server.getConfig");
    const provider = observed.providers.find(row => row.instanceId === PARENT_PROVIDER && row.enabled && row.status === "ready");
    const model = provider?.models.find(row => row.slug === PARENT_MODEL) ?? provider?.models[0];
    if (!provider || !model) return;
    const hostId = this.core.hostId();
    let inbox = this.core.state.read().inbox;
    if (!inbox) {
      const binding = acp.bindInbox({ hostId, ...parentPromptRules() });
      const workspace = await this.core.workspace(binding.directory);
      inbox = { threadId: identity("thread", canonical([hostId, "inbox"])), sessionId: binding.sessionId,
        bindingPath: binding.bindingPath, directory: binding.directory, workspaceId: workspace.id,
        projectId: workspace.projectId, createdAt: new Date().toISOString(), pinGeneration: 0 };
      this.core.state.update(state => { if (!state.inbox) state.inbox = inbox; });
      inbox = this.core.state.read().inbox!;
    }
    let thread = (await this.core.reads.inventory()).threads.find(row => row.id === inbox!.threadId);
    if (thread?.deletedAt || thread?.archivedAt) throw new T3CompatibilityError("Nucleus inbox is deleted or archived");
    if (!thread) {
      const commandId = identity("inbox-launch", canonical([hostId, inbox.threadId]));
      await this.core.intents.effect(commandId, "orchestration.launchThread", {
        commandId, threadId: inbox.threadId, projectId: inbox.projectId, title: "Nucleus",
        modelSelection: { instanceId: PARENT_PROVIDER, model: model.slug },
        runtimeMode: !provider.supportedRuntimeModes?.length || provider.supportedRuntimeModes.includes("full-access") ? "full-access" : "approval-required",
        interactionMode: "default", workspaceStrategy: { type: "root" },
        initialMessage: { messageId: identity("message", commandId), text: HOLD_MARKER, attachments: [] },
      }, undefined, undefined, { resendUnknownAfterRead: true });
      thread = (await this.core.reads.inventory()).threads.find(row => row.id === inbox!.threadId);
      if (!thread) return;
    }
    // A link is never persisted or placed in an ACP prompt. A failed native open
    // has unknown delivery, so this connection does not blindly send it again.
    if (!this.previewAttempted && this.core.boardLink) {
      const url = await this.core.boardLink();
      this.previewAttempted = true;
      await this.core.rpc.call("preview.open", { threadId: inbox.threadId, url, reveal: true });
    }
    if (thread.pinnedAt === undefined) throw new T3CompatibilityError("inbox thread pinnedAt");
    if (thread.pinnedAt === null) {
      const generation = inbox.pinGeneration;
      const commandId = identity("inbox-pin", canonical([hostId, inbox.threadId, generation]));
      const prior = this.core.state.read().intents[commandId];
      if (prior?.status === "unknown") return; // Never repeat an uncertain pin.
      if (prior?.status === "settled") {
        this.core.state.update(state => { if (state.inbox) state.inbox.pinGeneration++; });
        return;
      }
      await this.core.intents.effect(commandId, "orchestration.dispatchCommand", { type: "thread.pin", commandId, threadId: inbox.threadId });
    }
  }
}
