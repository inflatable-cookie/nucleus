/** One permanent, host-owned ACP inbox. It is never a task or a role thread. */
import { config, decode, previewList, T3CompatibilityError } from "./contracts";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import type { Projection, T3Reads } from "./reads";
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
 * The bound on one operator `ui`, from inbox lookup to the board result
 * (nucleus#1415). The callback has a longer timeout so it can deliver that result.
 */
export const INBOX_UI_DEADLINE_MS = 20_000;

type InboxUiWait = <T>(operation: () => Promise<T>) => Promise<T>;

/** Each stage spends only the time left in the command's one budget. */
function inboxUiWait(): InboxUiWait {
  const deadline = performance.now() + INBOX_UI_DEADLINE_MS;
  const expired = () =>
    new Error("the board did not open in time; type ui again to retry");
  return async (operation) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw expired();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired()), Math.ceil(remaining));
      });
      const value = await Promise.race([timeout, operation()]);
      if (performance.now() >= deadline) throw expired();
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** One operator `ui` observed in the thread window, and how T3 is holding it. */
interface UiMessage {
  /** The message's own id: the identity its one attempt is recorded under. */
  id: string;
  /** The run the message started; `queued` is T3 holding it behind the inbox's live turn. */
  queued: boolean;
}
/** The board an operator `ui` ends in: shown now, already served, or a named failure. */
export interface InboxUiResult {
  status: "opened" | "reused" | "failed";
  detail?: string;
}

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
  /**
   * The `ui` messages an open is in flight for in this process. The inbox turn and the
   * pass can see the same `ui` at the same moment (a message is briefly `queued` while its
   * run starts), and one in-flight open keeps the other from opening a second tab.
   */
  private readonly serving = new Set<string>();
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
    let thread =
      (await this.core.reads.shellRow(inbox!.threadId)) ??
      (await this.core.reads.inventory()).threads.find(
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
      thread = (await this.core.reads.readShell()).threads.find(
        (row) => row.id === inbox!.threadId,
      );
      if (!thread) return;
    }
    // A link is never persisted or placed in an ACP prompt. A failed native open has
    // unknown delivery, so this connection does not blindly send it again. Opening is the
    // one supported reveal, so the connection's own open follows the same rule as `ui`: one
    // board tab, freshly revealed, and a failure here is the operator's `ui` to report.
    if (!this.previewAttempted && this.core.boardLink)
      await this.showBoardFor(inbox);
    await this.nameProject(inbox.projectId);
    await this.retitle(inbox.threadId, thread);
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
   * The operator's answer to `ui`, for the inbox turn that carries the prompt
   * (nucleus#1415).
   */
  async showBoard(): Promise<InboxUiResult> {
    const wait = inboxUiWait();
    const inbox = await this.inboxRecord(wait);
    // The window may lag the operator's prompt by an instant; the command still shows the
    // board, and its attempt is recorded without an id. Only a *queued* message is ever
    // served by the pass, so an unidentified attempt can never make the pass repeat itself.
    const message = await wait(() => this.operatorUi(inbox));
    const served = message ? this.servedUi(message) : null;
    if (served) return this.recordedUi(served);
    return await this.serveUi(inbox, message?.id ?? null, wait);
  }

  /**
   * Serve the `ui` T3 queued behind the inbox's held turn (nucleus#1415). While a decision
   * is open the inbox's turn is held, so T3 queues the operator's own message and the agent
   * never receives it; this pass answers it instead, from the same record and the same open
   * the held turn would have used. Decision delivery is untouched: the offer, its card and
   * the hold are all read-only here. Runs only for a message T3 has queued, never for one
   * the inbox's own turn is answering.
   */
  async serveQueuedUi(): Promise<void> {
    if (!this.core.boardLink) return;
    try {
      const wait = inboxUiWait();
      const inbox = await this.inboxRecord(wait);
      const message = await wait(() => this.operatorUi(inbox));
      if (!message?.queued) return;
      if (this.servedUi(message)) return;
      await this.serveUi(inbox, message.id, wait);
    } catch {
      // Nothing was sent for this message, so the next pass serves it.
    }
  }

  /** The newest exact `ui` the operator sent in the inbox thread's window. */
  private async operatorUi(inbox: {
    threadId: string;
  }): Promise<UiMessage | null> {
    let projection: Projection;
    try {
      projection = await this.core.reads.readProjection(
        inbox.threadId,
        "window",
      );
    } catch {
      return null;
    }
    // A message T3 queued behind the inbox's held run is in `messages` before it is a
    // turn item, and this list is what carries it while the agent cannot see it.
    const newest = projection.messages
      .filter((row) => row.role === "user" && row.text === "ui")
      .at(-1);
    if (!newest) return null;
    const run = newest.runId
      ? projection.runs.find((row) => row.id === newest.runId)
      : undefined;
    return { id: newest.id, queued: run?.status === "queued" };
  }

  /** Commands run against the pinned inbox the ordinary sweep maintains. */
  private async inboxRecord(wait: InboxUiWait) {
    const inbox = this.core.state.read().inbox;
    if (!inbox) throw new Error("Nucleus inbox is unavailable");
    const thread =
      (await wait(() => this.core.reads.shellRow(inbox.threadId))) ??
      (await wait(() => this.core.reads.inventory())).threads.find(
        (row) => row.id === inbox.threadId,
      );
    if (!thread) throw new Error("Nucleus inbox is unavailable");
    if (thread.deletedAt || thread.archivedAt)
      throw new T3CompatibilityError("Nucleus inbox is deleted or archived");
    return inbox;
  }

  /** The recorded attempt for this message, if one was made: `ui` is never replayed for it. */
  private servedUi(message: UiMessage) {
    const served = this.core.state.read().inbox?.ui;
    return served && served.messageId === message.id ? served : null;
  }

  /** What a recorded attempt says now: a finished open, a failure, or one still in flight. */
  private recordedUi(record: {
    status: "attempted" | "opened" | "failed";
    detail?: string;
  }): InboxUiResult {
    if (record.status === "failed")
      return {
        status: "failed",
        ...(record.detail ? { detail: record.detail } : {}),
      };
    return { status: "reused" };
  }

  /**
   * Show the board for one operator `ui`, once, inside the command's bound. The attempt is
   * recorded before the native open, so a crash or an unknown delivery is never replayed
   * blindly for the same message; a later `ui` is a new message and a new attempt.
   */
  private async serveUi(
    inbox: { threadId: string },
    messageId: string | null,
    wait: InboxUiWait,
  ): Promise<InboxUiResult> {
    const key = messageId ?? "";
    if (this.serving.has(key)) return { status: "reused" };
    this.serving.add(key);
    try {
      const at = new Date().toISOString();
      this.core.state.update((state) => {
        if (state.inbox)
          state.inbox.ui = { messageId, at, status: "attempted" };
      });
      const result = await this.showBoardFor(inbox, wait);
      this.core.state.update((state) => {
        if (state.inbox)
          state.inbox.ui = {
            messageId,
            at,
            status: result.status === "failed" ? "failed" : "opened",
            ...(result.detail ? { detail: result.detail } : {}),
          };
      });
      return result;
    } finally {
      this.serving.delete(key);
    }
  }

  /**
   * The board is revealed by opening it: the nightly exposes no RPC that reveals a retained
   * tab (`PreviewManager.requestReveal` is internal to T3's in-process broker), and
   * `preview.open` always creates the tab it reveals. This thread's board tabs are therefore
   * closed first and one fresh tab is opened with a new one-time pairing link, so exactly one
   * board tab remains and the open is what brings the pane up. Pairing URLs stay out of state
   * and logs.
   */
  private async showBoardFor(
    inbox: { threadId: string },
    wait = inboxUiWait(),
  ): Promise<InboxUiResult> {
    try {
      const boardLink = this.core.boardLink;
      if (!boardLink) throw new Error("The local board service is unavailable");
      const listed = decode(
        previewList,
        await wait(() =>
          this.core.rpc.call("preview.list", { threadId: inbox.threadId }),
        ),
        "preview.list",
      );
      const link = await wait(boardLink);
      this.boardOrigin = originOf(link);
      const boardTabs = listed.sessions.filter((session) => {
        if (session.navStatus._tag === "Idle") return false;
        return originOf(session.navStatus.url) === this.boardOrigin;
      });
      for (const tab of boardTabs)
        await wait(() =>
          this.core.rpc
            .call("preview.close", {
              threadId: inbox.threadId,
              tabId: tab.tabId,
            })
            .catch(() => undefined),
        );
      await wait(() => {
        this.previewAttempted = true;
        return this.core.rpc.call("preview.open", {
          threadId: inbox.threadId,
          url: link,
          reveal: true,
        });
      });
      return { status: "opened" };
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The thread's live title. It is written only when it differs from the thread's
   * current title, and never wakes the inbox: a metadata update, not a turn. The
   * generation makes a title that returns to an earlier value a new command.
   */
  private async retitle(
    threadId: string,
    knownThread?: Awaited<ReturnType<T3Reads["shellRow"]>>,
  ): Promise<void> {
    const hostId = this.core.hostId();
    const key = this.core.acp()?.pendingInboxDecisionKey?.(hostId) ?? null;
    const decisions = key ? (JSON.parse(key) as unknown[]).length : 0;
    const title = inboxTitle(decisions, this.core.runningTasks());
    const thread = knownThread ?? (await this.core.reads.shellRow(threadId));
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
    const project = (await this.core.reads.shell()).projects.find(
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
