/** One permanent, host-owned ACP inbox. It is never a task or a role thread. */
import { config, decode, previewList, T3CompatibilityError } from "./contracts";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import type { T3Reads } from "./reads";
import type { T3RpcClient } from "./rpc";
import type { AcpSessionSurface } from "../../shared/acp/surface";
import {
  HOLD_MARKER,
  parentPromptRules,
  PARENT_MODEL,
  PARENT_PROVIDER,
} from "./nesting";

const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/** The T3 project name of the inbox's dedicated registration (nucleus#1384). */
export const INBOX_PROJECT_TITLE = "Nucleus Inbox";

/**
 * The inbox thread's one live signal (nucleus#1384, v2): decisions to answer first, then
 * tasks running on this host, otherwise "All quiet". Counts are the caller's facts.
 */
export function inboxTitle(decisions: number, runningTasks: number): string {
  if (decisions > 0)
    return `${decisions} decision${decisions === 1 ? "" : "s"} to answer`;
  if (runningTasks > 0)
    return `${runningTasks} task${runningTasks === 1 ? "" : "s"} running`;
  return "All quiet";
}

interface InboxContext {
  hostId(): string;
  /** Tasks whose attention is active on this host in the current pass (each task once). */
  runningTasks(): number;
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
  private boardOrigin: string | null = null;
  constructor(private readonly core: InboxContext) {}

  async reconcile(): Promise<void> {
    const acp = this.core.acp();
    if (!acp?.bindInbox) return;
    const observed = decode(
      config,
      await this.core.rpc.call("server.getConfig", {}),
      "server.getConfig",
    );
    const provider = observed.providers.find(
      (row) =>
        row.instanceId === PARENT_PROVIDER &&
        row.enabled &&
        row.status === "ready",
    );
    const model =
      provider?.models.find((row) => row.slug === PARENT_MODEL) ??
      provider?.models[0];
    if (!provider || !model) return;
    const hostId = this.core.hostId();
    let inbox = this.core.state.read().inbox;
    if (!inbox) {
      const binding = acp.bindInbox({ hostId, ...parentPromptRules() });
      const workspace = await this.core.workspace(binding.directory);
      inbox = {
        threadId: identity("thread", canonical([hostId, "inbox"])),
        sessionId: binding.sessionId,
        bindingPath: binding.bindingPath,
        directory: binding.directory,
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        createdAt: new Date().toISOString(),
        pinGeneration: 0,
        titleGeneration: 0,
      };
      this.core.state.update((state) => {
        if (!state.inbox) state.inbox = inbox;
      });
      inbox = this.core.state.read().inbox!;
    }
    let thread = (await this.core.reads.inventory()).threads.find(
      (row) => row.id === inbox!.threadId,
    );
    if (thread?.deletedAt || thread?.archivedAt)
      throw new T3CompatibilityError("Nucleus inbox is deleted or archived");
    if (!thread) {
      const commandId = identity(
        "inbox-launch",
        canonical([hostId, inbox.threadId]),
      );
      await this.core.intents.effect(
        commandId,
        "orchestration.launchThread",
        {
          commandId,
          threadId: inbox.threadId,
          projectId: inbox.projectId,
          title: "Nucleus",
          modelSelection: { instanceId: PARENT_PROVIDER, model: model.slug },
          runtimeMode:
            !provider.supportedRuntimeModes?.length ||
            provider.supportedRuntimeModes.includes("full-access")
              ? "full-access"
              : "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: identity("message", commandId),
            text: HOLD_MARKER,
            attachments: [],
          },
        },
        undefined,
        undefined,
        { resendUnknownAfterRead: true },
      );
      thread = (await this.core.reads.inventory()).threads.find(
        (row) => row.id === inbox!.threadId,
      );
      if (!thread) return;
    }
    // A link is never persisted or placed in an ACP prompt. A failed native open
    // has unknown delivery, so this connection does not blindly send it again.
    if (!this.previewAttempted && this.core.boardLink) {
      const url = await this.core.boardLink();
      this.boardOrigin = originOf(url);
      this.previewAttempted = true;
      await this.core.rpc.call("preview.open", {
        threadId: inbox.threadId,
        url,
        reveal: true,
      });
    }
    await this.nameProject(inbox.projectId);
    await this.retitle(inbox.threadId);
    if (thread.pinnedAt === undefined)
      throw new T3CompatibilityError("inbox thread pinnedAt");
    if (thread.pinnedAt === null) {
      const generation = inbox.pinGeneration;
      const commandId = identity(
        "inbox-pin",
        canonical([hostId, inbox.threadId, generation]),
      );
      const prior = this.core.state.read().intents[commandId];
      if (prior?.status === "unknown") return; // Never repeat an uncertain pin.
      if (prior?.status === "settled") {
        this.core.state.update((state) => {
          if (state.inbox) state.inbox.pinGeneration++;
        });
        return;
      }
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        { type: "thread.pin", commandId, threadId: inbox.threadId },
      );
    }
  }

  /**
   * Open or reuse the board preview in the inbox thread on operator `ui`.
   * Reuses an existing healthy board tab for the current board origin without
   * minting a new pairing link; otherwise mints a fresh one-time pairing link
   * and opens it with `reveal: true`. Pairing URLs stay out of state and logs.
   */
  async openBoard(): Promise<{ status: "opened" | "reused" }> {
    if (!this.core.boardLink)
      throw new Error("The local board service is unavailable");
    let inbox = this.core.state.read().inbox;
    if (!inbox) {
      await this.reconcile();
      inbox = this.core.state.read().inbox;
    }
    if (!inbox) throw new Error("Nucleus inbox is unavailable");
    const thread = (await this.core.reads.inventory()).threads.find(
      (row) => row.id === inbox.threadId,
    );
    if (!thread) await this.reconcile();
    else if (thread.deletedAt || thread.archivedAt)
      throw new T3CompatibilityError("Nucleus inbox is deleted or archived");
    const listed = decode(
      previewList,
      await this.core.rpc.call("preview.list", { threadId: inbox.threadId }),
      "preview.list",
    );
    let url: string | null = null;
    if (!this.boardOrigin) {
      url = await this.core.boardLink();
      this.boardOrigin = originOf(url);
    }
    const matching = listed.sessions.filter((session) => {
      if (session.navStatus._tag === "Idle") return false;
      return originOf(session.navStatus.url) === this.boardOrigin;
    });
    this.previewAttempted = true;
    if (matching.some((session) => session.navStatus._tag !== "LoadFailed")) {
      return { status: "reused" };
    }
    for (const failed of matching) {
      if (failed.navStatus._tag === "LoadFailed") {
        await this.core.rpc
          .call("preview.close", {
            threadId: inbox.threadId,
            tabId: failed.tabId,
          })
          .catch(() => undefined);
      }
    }
    const link = url ?? (await this.core.boardLink());
    this.boardOrigin = originOf(link);
    await this.core.rpc.call("preview.open", {
      threadId: inbox.threadId,
      url: link,
      reveal: true,
    });
    return { status: "opened" };
  }

  /**
   * The thread's live title. It is written only when it differs from the thread's
   * current title, and never wakes the inbox: a metadata update, not a turn. The
   * generation makes a title that returns to an earlier value a new command.
   */
  private async retitle(threadId: string): Promise<void> {
    const hostId = this.core.hostId();
    const key = this.core.acp()?.pendingInboxDecisionKey?.(hostId) ?? null;
    const decisions = key ? (JSON.parse(key) as unknown[]).length : 0;
    const title = inboxTitle(decisions, this.core.runningTasks());
    const thread = (await this.core.reads.inventory()).threads.find(
      (row) => row.id === threadId,
    );
    if (!thread || thread.title === title) return;
    const generation = this.core.state.read().inbox?.titleGeneration ?? 0;
    const commandId = identity(
      "inbox-title",
      canonical([hostId, threadId, title, generation]),
    );
    await this.core.intents.effect(
      commandId,
      "orchestration.dispatchCommand",
      {
        type: "thread.metadata.update",
        commandId,
        threadId,
        title,
      },
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
    this.core.state.update((state) => {
      if (state.inbox) state.inbox.titleGeneration = generation + 1;
    });
  }

  /**
   * The inbox's registration keeps its identity; only its readable name changes. A new
   * registration is named in the same pass that creates it, and an owned registration from
   * before is renamed with T3's native project update, so the pinned thread, binding and
   * directory survive.
   */
  private async nameProject(projectId: string): Promise<void> {
    const project = (await this.core.reads.inventory()).projects.find(
      (row) => row.id === projectId,
    );
    if (!project || project.archivedAt || project.title === INBOX_PROJECT_TITLE)
      return;
    const commandId = identity(
      "project-title",
      canonical([this.core.hostId(), projectId, INBOX_PROJECT_TITLE]),
    );
    await this.core.intents.effect(
      commandId,
      "projects.mutate",
      {
        type: "project.update",
        commandId,
        projectId,
        title: INBOX_PROJECT_TITLE,
      },
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
  }
}
