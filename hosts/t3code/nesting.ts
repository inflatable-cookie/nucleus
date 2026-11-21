/**
 * Native parenting on T3 (nucleus#1305): a task is one T3 thread on the Nucleus
 * ACP provider, and every role thread — worker, reviewer, recovery, closeout — is
 * that thread's native subagent child.
 *
 * The shape, and why it is this shape:
 *
 * - The parent thread has no model. It runs the Nucleus ACP agent (Spec 065), which
 *   holds its turn while Nucleus says to and shows the task's lifecycle. Nucleus is
 *   the only author of what it says, so the parent authors nothing about the work.
 * - A child can only be created while the parent's run is live (`delegated_task
 *   .request` refuses a parent run that is not active), so this module holds the
 *   parent's turn for the whole time any child is active and releases it when none
 *   is. Re-entry is a message whose text the binding's `holdPattern` names: the ACP
 *   agent holds it and forwards nothing, so a re-entry is never mistaken for a person
 *   speaking to the task. See `docs/knowledge/specs/t3code-host-adapter.md`.
 * - A child is created with no `workspaceStrategy`, so T3 builds it from the parent
 *   and starts it at once. A role that cannot be a child — no provider, a finished
 *   parent, a different checkout — refuses before the send with the reason and the
 *   fix; there is no top-level fallback (Tom, 2026-11-19).
 * - Completion delivery is disposed for every child Nucleus creates and every
 *   follow-up it sends, so a child's result never wakes the parent agent. The nightly's
 *   own wake wordings are also ignored by the agent's binding, so even a lost dispose
 *   never reaches the task as a person's message.
 * - A child's own runtime requests are answered by Nucleus on the child; T3 is never
 *   asked to consult the parent about them (`runtime-request.respond` names the child).
 *
 * Everything here is a creation and presentation path: task identity, the run ledger,
 * profile selection and review/merge policy are unchanged, and Nucleus's durable intent
 * ledger still owns delivery — a failed mutation is unknown delivery, settled by a read
 * or never resent.
 */
import { z } from "zod";
import { T3_HOLD_TEXT } from "../../shared/acp/t3-hold";
import {
  HostReadRefusalError,
  isHostOperationTimeout,
  ProvenPreSendRefusalError,
} from "../../core/host";
import type { HostAgentAttempt, HostAgentSpec } from "../../shared/host";
import type { Profile, Task } from "../../shared/contracts";
import type { AcpSessionSurface } from "../../shared/acp/surface";
import type { T3RpcClient } from "./rpc";
import { config, T3CompatibilityError, type RuntimeMode } from "./contracts";
import {
  activeStatuses,
  isThreadNotFoundRpcError,
  isTransientT3ReadRpcError,
  T3TransientReadError,
  type Projection,
  type T3Reads,
} from "./reads";
import { identity, intentKindOf, intentThreadId, type T3IntentLedger } from "./intents";
import { canonical, type T3State, type T3StateFile } from "./state";
import { labelTask } from "./one-row";

/**
 * The provider instance an operator registers in T3's settings, the model the Nucleus
 * ACP agent advertises, and the nightly's driver name for such a provider. All three
 * are Nucleus's own constants, never read from remote text: T3 has no schema discovery,
 * so a mismatch is refused with guidance rather than guessed at.
 */
export const PARENT_PROVIDER = "nucleus";
export const PARENT_MODEL = "nucleus";
export const PARENT_DRIVER = "acpRegistry";

/**
 * The text of every re-entry prompt this module sends, and of the parent's opening
 * prompt. T3 shows a prompt as a user bubble, so the text is a plain sentence with no
 * internal marker or task id. The binding's `holdPattern` matches it exactly (see
 * `parentPromptRules`), so the ACP agent holds that turn and forwards nothing. Exactly
 * one place decides what a person is, and it is configuration, never parsed remote text.
 */
export const HOLD_MARKER = T3_HOLD_TEXT;

/**
 * T3's own wordings for text that is not a person speaking to a task: a delegated
 * task's completion wake (all of the nightly's wordings carry the derived task-id
 * prefix) and the note it starts a restart continuation run with. The binding's
 * `ignorePattern` names them, so even a lost dispose never puts remote text into the
 * task's message log. These are this adapter's constants — anchored substrings, never
 * parsed remote structure.
 */
export const T3_NOTICE_PHRASES = [
  "Delegated task node:delegated-task:",
  "Cancelled because the server restarted",
  "Cancelled because the server shut down",
] as const;

/** The prompt rules a launched ACP agent reads from its binding. */
export const parentPromptRules = (): {
  ignorePattern: string;
  holdPattern: string;
} => ({
  ignorePattern: T3_NOTICE_PHRASES.map((phrase) =>
    phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"),
  // Anchored and escaped: only this exact sentence is a re-entry, never a message that
  // merely contains it.
  holdPattern: `^${HOLD_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
});

/** The child thread a delegated-task command creates (nightly `idAllocator.derive`). */
export const childThreadId = (commandId: string): string =>
  `thread:delegated-task:${commandId}`;
/** The delegated task node the same command creates; the id a dispose names. */
export const childTaskId = (commandId: string): string =>
  `node:delegated-task:${commandId}`;

/** How long a re-entry waits for the parent's run to appear before the create refuses. */
export const REENTRY_TIMEOUT_MS = 20_000;
/** How long a just-launched parent gets to show its run before it counts as released. */
const LAUNCH_RUN_TIMEOUT_MS = 5_000;
const REENTRY_POLL_MS = 500;
/** A child create right after a re-entry is protected from a concurrent release sweep. */
const HOLD_GRACE_MS = 60_000;

type ConfigModel = z.infer<
  typeof config
>["providers"][number]["models"][number];
type ConfigProvider = z.infer<typeof config>["providers"][number];
type ParentThread = NonNullable<T3State["parents"]>[string];

export interface T3NestingContext {
  rpc: T3RpcClient;
  state: T3StateFile;
  reads: T3Reads;
  intents: T3IntentLedger;
  /** The one presentation call a re-entry needs: a settled thread does not start a run. */
  presentation: {
    wakeBeforeDelivery(threadId: string, messageId: string): Promise<void>;
  };
  hostId(): string;
  requireConnection(): void;
  /** The service's ACP session surface; absent in a process that serves no ACP sessions. */
  acp(): AcpSessionSurface | null;
  /**
   * The role's own model options, from the launch's config read. Computed by the
   * host against the role's model, never the parent provider's (the parent carries
   * the Nucleus ACP agent's model and no thinking carrier).
   */
  modelSelectionOptionsFor(
    profile: Profile,
    provider: ConfigProvider | undefined,
    model: ConfigModel | undefined,
  ): Array<{ id: string; value: string | boolean }>;
  /** The role's runtime mode as the role's provider offers it. */
  roleRuntimeMode(
    provider: z.infer<typeof config>["providers"][number],
    profile: Profile,
  ): RuntimeMode;
  /** A re-entry's bounded wait for the parent's run; the product default unless overridden. */
  reentryTimeoutMs?: number;
}

/**
 * The answer one role create gives (nucleus#1366). It either names the child it
 * created, or refuses before the send with the reason and the fix the task shows;
 * there is no third answer that launches a top-level role thread.
 */
export type NestedCreateResult =
  | { ok: true; id: string; workspaceId: string }
  | { ok: false; reason: string };

/** One create this module may own: everything the launch already read, plus the child's identity. */
export interface NestedCreateInput {
  spec: HostAgentSpec;
  attempt: HostAgentAttempt;
  profile: Profile;
  /** The role's own provider entry and model from the launch's config read. */
  roleProvider: ConfigProvider;
  roleModel: ConfigModel | undefined;
  workspace: { id: string; projectId: string; directory: string };
  /** The launch's one `server.getConfig` read. */
  observed: z.infer<typeof config>;
  /** The child's title, already numbered by the host. */
  title: string;
}

export class T3Nesting {
  constructor(private readonly core: T3NestingContext) {}

  /** The parent record of one task, when this host is nesting it. */
  parentOf(taskId: string): ParentThread | undefined {
    return this.core.state.read().parents?.[taskId];
  }

  /** Whether this thread is a task's parent thread (never a child, never a run's agent). */
  isParent(threadId: string): boolean {
    return Object.values(this.core.state.read().parents ?? {}).some(
      (parent) => parent.threadId === threadId,
    );
  }

  /**
   * The task one nested child belongs to, when this host recorded it as a child.
   * Only the child's own recorded parent thread counts: a role thread of a parented
   * task that fell back to a top-level launch is a top-level thread and keeps every
   * one-row and settle rule (nucleus#1305 review).
   */
  taskOfChild(threadId: string): string | undefined {
    const state = this.core.state.read();
    const agent = state.agents[threadId];
    const taskId = labelTask(agent?.labels);
    if (!agent?.parentThreadId || !taskId) return undefined;
    return state.parents?.[taskId]?.threadId === agent.parentThreadId
      ? taskId
      : undefined;
  }

  /** What the host status reports: whether this host can nest roles, or why it cannot. */
  statusLine(): string {
    const nesting = this.core.state.read().nesting;
    if (!nesting) return "native parenting not used yet";
    return nesting.state === "nested"
      ? "native parenting on the nucleus ACP provider"
      : `native parenting unavailable: ${nesting.reason}`;
  }

  /**
   * The connect probe's read-only answer: whether the nested path is available right
   * now, recorded so `service.health` can say it before any task is dispatched. The
   * probe sends nothing; a provider an operator registers later is picked up by the
   * next connect or the next create's own read.
   */
  recordProvider(observed: z.infer<typeof config>): void {
    const at = new Date().toISOString();
    if (!this.core.acp()) {
      this.core.state.update((state) => {
        state.nesting = {
          state: "unavailable",
          reason: "this process serves no ACP sessions",
          at,
        };
      });
      return;
    }
    const provider = this.parentProvider(observed);
    this.core.state.update((state) => {
      state.nesting = provider.ok
        ? { state: "nested", reason: "", at }
        : { state: "unavailable", reason: provider.reason, at };
    });
  }

  /**
   * Create one role thread as a child of the task's parent, or refuse before the
   * send with the reason and the fix (nucleus#1366). A refusal is *nothing sent*:
   * every reason is proven before the child command, and a child command whose
   * outcome is unknown is resolved by reading the deterministic child id first.
   */
  async create(input: NestedCreateInput): Promise<NestedCreateResult> {
    const taskId = labelTask(input.attempt.labels);
    if (!taskId) return this.unavailable("", "the launch names no task");
    const acp = this.core.acp();
    if (!acp)
      return this.unavailable(
        taskId,
        `T3 provider not ready: this process serves no ACP sessions, so the ${PARENT_PROVIDER} provider has nothing to run; run \`nucleus t3 install\` on an ACP-capable host, or move the task to another host`,
      );
    const provider = this.parentProvider(input.observed);
    if (!provider.ok) return this.unavailable(taskId, provider.reason);
    // Resolve the role's model and mode before a parent can be launched.
    const options = this.core.modelSelectionOptionsFor(
      input.profile,
      input.roleProvider,
      input.roleModel,
    );
    const runtimeMode = this.core.roleRuntimeMode(
      input.roleProvider,
      input.profile,
    );
    const existing = this.parentOf(taskId);
    let existingSharedProjection: Projection | undefined;
    // A binding stored before its launch was sent (nucleus#1458) is resumed, not
    // treated as a parent that already ran.
    let prepared: ParentThread | undefined;
    if (existing) {
      // A child with no workspace strategy inherits the parent's checkout, and one
      // with a strategy never starts outside T3's own MCP handler. A role whose run
      // needs another checkout therefore cannot be a child, and there is no
      // top-level fallback any more: the task waits visibly instead.
      if (existing.workspaceId !== input.workspace.id)
        return this.unavailable(
          taskId,
          `the task's parent thread is bound to another checkout (${existing.workspaceId}, this run uses ${input.workspace.id}); move the task to another host or restart it on a new workspace`,
        );
      // Old markers did not distinguish archive from deletion. Re-read the exact
      // binding before acting on either an old marker or a new observation,
      // sharing its narrow projection with the held-turn check below.
      const observation = await this.classifyParent(existing, true);
      if (this.preparedParent(taskId, observation)) {
        // Prepared: absent from the complete inventory with no launch intent. Resume
        // its launch under the same identity; a checkout or project that no longer
        // matches the binding is refused instead.
        if (
          existing.projectId !== input.workspace.projectId ||
          existing.directory !== input.workspace.directory
        )
          return this.unavailable(
            taskId,
            "the task's parent thread no longer matches its recorded project and checkout; inspect the binding before restarting",
          );
        prepared = existing;
      } else {
        if (observation.kind !== "live") {
          if (observation.kind === "archived" || observation.kind === "deleted")
            this.finishParent(taskId, observation.kind);
          return this.unavailable(
            taskId,
            observation.kind === "mismatched"
              ? "the task's parent thread no longer matches its recorded project and checkout; inspect the binding before restarting"
              : observation.kind === "archived"
                ? "the task's parent thread is archived; use an owner restart after prior creation and delivery settle"
                : "the task's parent thread is deleted; inspect the retained binding and recovery before continuing",
          );
        }
        existingSharedProjection = observation.projection;
        // An exact live observation repairs even a legacy finished marker after a
        // manual unarchive. A sweep alone never unarchives the parent.
        if (existing.archivedAt) {
          this.core.state.update((state) => {
            const current = state.parents?.[taskId];
            if (current?.threadId === existing.threadId) delete current.archivedAt;
          });
        }
        // The create owns the turn from here: a concurrent sweep must not release it
        // between the parent-run read and the child command.
        this.core.state.update((state) => {
          const current = state.parents?.[taskId];
          if (current) current.holdingSince = new Date().toISOString();
        });
      }
    }
    // A launch this create makes, or resumes, starts its run asynchronously.
    const launching = !existing || prepared !== undefined;
    const parent =
      existing && !prepared
        ? existing
        : await this.launchParent(input, provider, acp, prepared);
    if (!parent)
      return this.unavailable(
        taskId,
        "the task's parent thread could not be created; restart the task or move it to another host",
      );
    // The launch's own request id is the child command's identity: one durable
    // identity per launch, as the top-level launch used to carry, so a replay
    // replays this exact child instead of minting a second one.
    const commandId = input.attempt.requestId;
    const threadId = childThreadId(commandId);
    // A parent this launch just created starts its run asynchronously; one that
    // already existed and lost its turn needs the re-entry at once.
    const live = await this.heldRun(
      parent,
      input.attempt.requestId,
      launching ? LAUNCH_RUN_TIMEOUT_MS : 0,
      existingSharedProjection,
    );
    if (!live)
      return this.unavailable(
        taskId,
        "the task's parent thread did not reach a live run; restart the task or move it to another host",
      );
    const payload = {
      type: "delegated_task.request",
      createdBy: "user",
      creationSource: "server",
      commandId,
      parentThreadId: parent.threadId,
      parentRunId: live.id,
      parentNodeId: live.rootNodeId,
      task: input.attempt.prompt,
      title: input.title,
      modelSelection: {
        instanceId: input.profile.provider,
        model: input.profile.model,
        ...(options.length ? { options } : {}),
      },
      runtimeMode,
      interactionMode: "default",
      // Belt and braces beside the dispose below: a `settled_only` child never wakes a
      // live parent, even if this process dies before that dispose lands.
      completionWake: "settled_only",
    };
    // Record the child's identity before the send, so a lost reply cannot produce an
    // unowned thread: the id is derived from the command id, never from an answer.
    this.core.state.update((state) => {
      const old = state.agents[threadId],
        record = {
          id: threadId,
          workspaceId: input.workspace.id,
          labels: input.attempt.labels,
        };
      if (
        old &&
        canonical({
          id: old.id,
          workspaceId: old.workspaceId,
          labels: old.labels,
        }) !== canonical(record)
      )
        throw new ProvenPreSendRefusalError("T3Code retained identity changed");
      state.agents[threadId] = {
        ...old,
        ...record,
        title: input.title,
        parentThreadId: parent.threadId,
      };
      // A child created again on a thread id this host had retired is observed again.
      delete state.retiredAgents?.[threadId];
    });
    try {
      await this.core.intents.effect(
        commandId,
        "orchestration.dispatchCommand",
        payload,
        () => {
          if (input.spec.guard && !input.spec.guard.stillAllowed())
            throw new ProvenPreSendRefusalError("T3Code launch guard changed");
        },
      );
    } catch (error) {
      if (await this.adoptChild(parent, commandId))
        return { ok: true, id: threadId, workspaceId: input.workspace.id };
      this.core.state.update((state) => {
        delete state.agents[threadId];
      });
      if (!(error instanceof ProvenPreSendRefusalError)) throw error;
      return this.unavailable(
        taskId,
        `the role child was refused before delivery: ${error.reason}; restart the task or move it to another host`,
      );
    }
    this.core.state.update((state) => {
      const record = state.parents?.[taskId];
      if (record) delete record.releasedAt;
    });
    await this.dispose(parent, childTaskId(commandId)).catch(() => undefined);
    return { ok: true, id: threadId, workspaceId: input.workspace.id };
  }

  /**
   * Restore the retained parent for an already-admitted owner restart. The caller
   * owns restart authorization and must settle creation and custody before calling.
   * A fresh inventory is read before and after the effect, including after a lost
   * reply. Unknown delivery is never replayed or replaced by a new operation.
   */
  async restoreForRestart(
    task: Task,
    operationId: string,
    stillAllowed: () => boolean,
    beforeSend: () => void = () => {},
  ): Promise<void> {
    const parent = this.parentOf(task.id);
    if (!parent) return;
    const workspace = this.core.state.read().workspaces[parent.workspaceId];
    if (!task.workspaceId || parent.workspaceId !== task.workspaceId || task.directory !== parent.directory ||
        !workspace || workspace.archivedAt || workspace.projectId !== parent.projectId || workspace.directory !== parent.directory ||
        task.removedAt || ["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit)
      throw new ProvenPreSendRefusalError("T3Code parent restore requires the same nonterminal task and workspace");
    // Null: a prepared binding (nucleus#1458). Nothing reached T3, so there is no
    // parent to restore, and the worker's create launches the same parent.
    const observe = async () => {
      const classified = await this.classifyParent(parent, true);
      if (this.preparedParent(task.id, classified)) return null;
      if (classified.kind === "deleted")
        throw new ProvenPreSendRefusalError(
          "the task's parent thread is deleted; inspect its recovery before restarting",
        );
      if (classified.kind === "mismatched")
        throw new ProvenPreSendRefusalError(
          "the task's parent thread no longer matches its recorded binding; inspect it before restarting",
        );
      return classified.row;
    };
    let row = await observe();
    if (!row) {
      if (!stillAllowed()) throw new ProvenPreSendRefusalError("restart authorization changed during parent restore");
      return;
    }
    if (row.archivedAt) {
      if (!operationId) throw new ProvenPreSendRefusalError("An archived parent requires a durable owner restart operation");
      const unknown = Object.values(this.core.state.read().intents).some(
        (intent) => intentKindOf(intent) === "thread.unarchive" && intentThreadId(intent) === parent.threadId && intent.status === "unknown",
      );
      if (unknown) throw new Error("the parent unarchive delivery remains unknown; observe the same parent before retrying");
      const commandId = identity("parent-unarchive", canonical([this.core.hostId(), parent.threadId, operationId]));
      try {
        await this.core.intents.effect(commandId, "orchestration.dispatchCommand", {
          type: "thread.unarchive", commandId, threadId: parent.threadId,
        }, () => {
          const current = this.parentOf(task.id);
          if (!stillAllowed() || !current || current.threadId !== parent.threadId ||
              current.workspaceId !== parent.workspaceId || current.projectId !== parent.projectId ||
              current.directory !== parent.directory || current.sessionId !== parent.sessionId || current.bindingPath !== parent.bindingPath)
            throw new ProvenPreSendRefusalError("restart authorization or parent binding changed before parent restore");
          beforeSend();
        });
      } catch (error) {
        if (error instanceof ProvenPreSendRefusalError) throw error;
        // A live exact parent proves the desired state even if the reply was lost.
        // An unreadable or still-archived parent preserves the original failure.
        try {
          row = await observe();
        } catch (observeError) {
          if (observeError instanceof ProvenPreSendRefusalError)
            throw observeError;
          throw error;
        }
        if (!row || row.archivedAt) throw error;
      }
      row = await observe();
      if (!row || row.archivedAt) throw new Error("the parent unarchive is not yet observable; no child was created");
    }
    if (!stillAllowed()) throw new ProvenPreSendRefusalError("restart authorization changed during parent restore");
    this.core.state.update((state) => {
      const current = state.parents?.[task.id];
      if (current?.threadId === parent.threadId && current.workspaceId === parent.workspaceId)
        delete current.archivedAt;
    });
  }

  /** Observe only the exact restore occurrence of an interrupted restart. */
  async observeRestartRestore(task: Task, operationId: string): Promise<"not_found" | "live" | "archived" | "deleted" | "mismatched" | "unobservable"> {
    const parent = this.parentOf(task.id);
    if (!parent || !operationId) return "not_found";
    const commandId = identity("parent-unarchive", canonical([this.core.hostId(), parent.threadId, operationId]));
    const intent = this.core.state.read().intents[commandId];
    if (!intent || intentKindOf(intent) !== "thread.unarchive" || intentThreadId(intent) !== parent.threadId ||
        (intent.status !== "unknown" && intent.status !== "settled")) return "not_found";
    const workspace = this.core.state.read().workspaces[parent.workspaceId];
    if (!task.workspaceId || parent.workspaceId !== task.workspaceId || task.directory !== parent.directory ||
        !workspace || workspace.archivedAt || workspace.projectId !== parent.projectId || workspace.directory !== parent.directory ||
        task.removedAt || ["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit)
      return "mismatched";
    try {
      return (await this.parentGone(parent)) ?? "live";
    } catch {
      return "unobservable";
    }
  }

  /**
   * A follow-up to a live child starts a new delegated task under the dispatch's own
   * command id, and T3 does not dispose that wake. Dispose it here; the message itself
   * already succeeded, so nothing about this may fail the send.
   */
  async afterFollowUp(threadId: string, commandId: string): Promise<void> {
    const taskId = this.taskOfChild(threadId);
    if (!taskId) return;
    const parent = this.parentOf(taskId);
    if (!parent) return;
    // T3 started a new delegated task under the dispatch's own command id, so the
    // follow-up has its own child thread in the task's workspace. Record its
    // identity (labels of the role it continues) so the closeout participant proof
    // reads the task's own idle thread, not a foreign reader (nucleus#1366).
    const followUpId = childThreadId(commandId);
    const role = this.core.state.read().agents[threadId];
    if (role && followUpId !== threadId) {
      this.core.state.update((state) => {
        if (
          state.agents[followUpId] ||
          state.followUps?.[followUpId] ||
          state.retiredAgents?.[followUpId]
        )
          return;
        state.followUps = {
          ...state.followUps,
          [followUpId]: {
            workspaceId: role.workspaceId,
            labels: role.labels,
            parentThreadId: parent.threadId,
          },
        };
      });
    }
    await this.dispose(parent, childTaskId(commandId)).catch(() => undefined);
  }

  /**
   * The ordinary host sweep's nesting pass: dispose every wake still owed, release the
   * parent's turn when no child runs, and archive the parent of a finished task. Every
   * step reads first, so a lost reply is settled by a fact and never resent blindly.
   */
  async reconcile(tasks: readonly Task[]): Promise<void> {
    if (!Object.keys(this.core.state.read().parents ?? {}).length) return;
    this.core.requireConnection();
    for (const task of tasks) {
      const parent = this.parentOf(task.id);
      if (!parent || parent.archivedAt) continue;
      if (
        task.removedAt != null ||
        task.phase === "done" ||
        task.phase === "cancelled"
      ) {
        // A finished task creates no further child, so its held turn is released at
        // once — the create grace window is for live work and must never keep a
        // terminal thread busy against the closeout lane (nucleus#1366). The
        // release is a local ACP call, so a thread that left observation is still
        // released: the workspace archive proof reads its run state.
        await this.release(parent).catch((error) => {
          if (isHostOperationTimeout(error)) throw error;
        });
        await this.archiveParent(parent).catch((error) => {
          if (isHostOperationTimeout(error)) throw error;
        });
        continue;
      }
      // A parent that left observation is read no further: its task is over, and the
      // archive above is the whole remaining work for it (nucleus#1328).
      if (!this.core.reads.observes(parent.threadId)) continue;
      let projection: Projection;
      try {
        projection = await this.core.reads.readProjection(
          parent.threadId,
          "observation",
        );
      } catch (error) {
        if (isHostOperationTimeout(error)) throw error;
        continue;
      }
      if (projection.thread.deletedAt) {
        // A live task keeps its binding even when T3 deletes the parent: dropping
        // it would let a later role launch a second, unrelated parent.
        this.finishParent(task.id, "deleted");
        continue;
      }
      await this.disposePending(parent, projection);
      if (projection.thread.archivedAt) continue;
      if (!projection.runs.some((run) => activeStatuses.has(run.status)))
        continue;
      if (this.core.acp()?.pendingDecisionKey?.(task.id)) continue;
      if (this.holding(parent)) continue;
      if (await this.anyChildLive(task.id)) continue;
      await this.release(parent);
    }
  }

  // ---------------------------------------------------------------- parent thread

  /** The provider instance, model and offered runtime modes a parent launch needs. */
  private parentProvider(observed: z.infer<typeof config>):
    | {
        ok: true;
        model: ConfigModel;
        supportedRuntimeModes?: readonly RuntimeMode[];
      }
    | { ok: false; reason: string } {
    const provider: ConfigProvider | undefined = observed.providers.find(
      (candidate) => candidate.instanceId === PARENT_PROVIDER,
    );
    const install = `run \`nucleus t3 install\``;
    if (!provider) {
      const stored = observed.settings?.providerInstances?.[PARENT_PROVIDER];
      if (stored) {
        if (stored.driver !== undefined && stored.driver !== PARENT_DRIVER)
          return {
            ok: false,
            reason: `T3 provider not ready: T3Code provider ${PARENT_PROVIDER} is not an ACP provider (the ${PARENT_DRIVER} driver); ${install}`,
          };
        return {
          ok: false,
          reason: `T3 provider not ready: T3Code provider ${PARENT_PROVIDER} is registered but not ready (${stored.enabled === false ? "disabled" : "status unknown; T3Code has not reported a probe result"}); ${install}`,
        };
      }
      return {
        ok: false,
        reason: `T3 provider not ready: T3Code has no ${PARENT_PROVIDER} ACP provider instance; ${install}`,
      };
    }
    if (provider.driver !== undefined && provider.driver !== PARENT_DRIVER)
      return {
        ok: false,
        reason: `T3 provider not ready: T3Code provider ${PARENT_PROVIDER} is not an ACP provider (the ${PARENT_DRIVER} driver); ${install}`,
      };
    if (!provider.enabled || provider.status !== "ready")
      return {
        ok: false,
        reason: `T3 provider not ready: T3Code provider ${PARENT_PROVIDER} is registered but not ready (${provider.enabled ? provider.status : "disabled"})${provider.message ? `: ${provider.message}` : ""}; ${install}`,
      };
    const model =
      provider.models.find((candidate) => candidate.slug === PARENT_MODEL) ??
      provider.models[0];
    if (!model)
      return {
        ok: false,
        reason: `T3 provider not ready: T3Code provider ${PARENT_PROVIDER} reports no model; the Nucleus ACP agent advertises ${PARENT_MODEL}; ${install}`,
      };
    return {
      ok: true,
      model,
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  }

  /** The deterministic command id of one task's parent launch. */
  private parentLaunchId(taskId: string): string {
    return identity("parent-launch", canonical([this.core.hostId(), taskId]));
  }

  /** Whether this task's parent launch was ever reserved for a send (nucleus#1458). */
  private parentLaunchReserved(taskId: string): boolean {
    return this.core.state.read().intents[this.parentLaunchId(taskId)] !== undefined;
  }

  /**
   * The task's parent thread, launched on the Nucleus ACP provider, or a proven refusal.
   * The binding is minted first, because the launched agent resolves its session from
   * the checkout it starts in; the thread id is deterministic, so a lost reply is
   * settled by finding the thread, and only a proven absence launches it again under
   * the same command identity. A `bound` binding (nucleus#1458) was stored by an earlier
   * pass whose launch never reserved a send: it is resumed as stored, never minted again.
   */
  private async launchParent(
    input: NestedCreateInput,
    provider: {
      ok: true;
      model: ConfigModel;
      supportedRuntimeModes?: readonly RuntimeMode[];
    },
    acp: AcpSessionSurface,
    bound?: ParentThread,
  ): Promise<ParentThread | null> {
    const taskId = labelTask(input.attempt.labels)!;
    const threadId = identity(
      "thread",
      canonical([this.core.hostId(), taskId, "parent"]),
    );
    const binding = bound
      ? { sessionId: bound.sessionId, bindingPath: bound.bindingPath }
      : acp.bind({ taskId, ...parentPromptRules() });
    const record: ParentThread = {
      taskId,
      threadId,
      holdText: HOLD_MARKER,
      sessionId: binding.sessionId,
      bindingPath: binding.bindingPath,
      workspaceId: input.workspace.id,
      projectId: input.workspace.projectId,
      directory: input.workspace.directory,
      createdAt: bound?.createdAt ?? new Date().toISOString(),
      title: input.title,
    };
    // Durable before the send: a lost reply leaves an owned parent, never an orphan.
    this.core.state.update((state) => {
      const old = state.parents?.[taskId];
      if (
        old &&
        (old.threadId !== threadId || old.sessionId !== binding.sessionId)
      )
        throw new ProvenPreSendRefusalError(
          "T3Code parent thread identity changed",
        );
      state.parents = { ...state.parents, [taskId]: old ?? record };
      state.nesting = {
        state: "nested",
        reason: "",
        at: new Date().toISOString(),
      };
    });
    const known = await this.knownParentThread(taskId, threadId);
    if (known) {
      if (known.deletedAt) return null;
      this.core.state.update((state) => {
        const current = state.parents?.[taskId];
        if (current) state.parents![taskId] = { ...current, ...record };
      });
      return this.parentOf(taskId) ?? record;
    }
    const offered = provider.supportedRuntimeModes ?? [];
    const runtimeMode: RuntimeMode =
      offered.length === 0 || offered.includes("full-access")
        ? "full-access"
        : "approval-required";
    const commandId = this.parentLaunchId(taskId);
    const payload = {
      commandId,
      threadId,
      projectId: input.workspace.projectId,
      title: record.title ?? PARENT_PROVIDER,
      modelSelection: {
        instanceId: PARENT_PROVIDER,
        model: provider.model.slug,
      },
      runtimeMode,
      interactionMode: "default",
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: input.workspace.directory,
      },
      // The opening prompt is never forwarded by the ACP agent (Spec 065): it
      // establishes the thread and holds the turn, and the agent shows the task's
      // lifecycle rather than inventing anything of its own.
      initialMessage: {
        messageId: identity("message", commandId),
        text: HOLD_MARKER,
        attachments: [],
      },
    };
    await this.core.intents.effect(
      commandId,
      "orchestration.launchThread",
      payload,
      () => {
        // The launch guard is a synchronous pre-send fence: a guard that turned false
        // refuses before the parent thread is created, so a refused role leaves no
        // thread behind.
        if (input.spec.guard && !input.spec.guard.stillAllowed())
          throw new ProvenPreSendRefusalError("T3Code launch guard changed");
      },
      undefined,
      { resendUnknownAfterRead: true },
    );
    if (this.core.reads.threadShapePending) {
      // The first created thread is the shape this connection proves. A
      // compatibility failure must surface (the host goes offline with the field
      // named); a thread T3 has not listed yet is a transient read the next pass
      // owns, and must not fail the launch.
      try {
        await this.core.reads.readProjection(threadId, "observation");
      } catch (error) {
        if (error instanceof T3CompatibilityError) throw error;
      }
    }
    return this.parentOf(taskId) ?? record;
  }

  /** A parent run that can carry a child: live, and naming its own root node. */
  private async activeParentRun(
    threadId: string,
    waitMs = 0,
    sharedProjection?: Projection,
  ): Promise<{ id: string; rootNodeId: string } | null> {
    const pickActive = (projection: Projection) => {
      if (projection.thread.deletedAt) return null;
      const runs = projection.runs.filter(
        (run) =>
          activeStatuses.has(run.status) &&
          typeof run.rootNodeId === "string" &&
          run.rootNodeId,
      );
      const latest = runs
        .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1))
        .at(-1);
      return latest ? { id: latest.id, rootNodeId: latest.rootNodeId! } : null;
    };
    if (sharedProjection) {
      const fromShared = pickActive(sharedProjection);
      if (fromShared || sharedProjection.thread.deletedAt || waitMs <= 0)
        return fromShared;
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      let projection: Projection;
      try {
        projection = await this.core.reads.readDirectProjection(
          threadId,
          "observation",
          waitMs > 0,
        );
      } catch (error) {
        if (isThreadNotFoundRpcError(error)) return null;
        if (isTransientT3ReadRpcError(error))
          throw new T3TransientReadError(error);
        if (error instanceof HostReadRefusalError) throw error;
        throw error;
      }
      if (projection.thread.deletedAt) return null;
      const latest = pickActive(projection);
      if (latest) return latest;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, REENTRY_POLL_MS));
    }
  }

  /**
   * The parent's live run, re-entered if it has none. A held turn is what makes a
   * child creatable, so "no active run" means "re-arm the thread, then wait for T3 to
   * start it". The wait is bounded: a parent T3 will not run is a proven reason to
   * keep the task waiting with a visible reason.
   */
  private async heldRun(
    parent: ParentThread,
    requestId: string,
    waitMs = 0,
    sharedProjection?: Projection,
  ): Promise<{ id: string; rootNodeId: string } | null> {
    const active = await this.activeParentRun(
      parent.threadId,
      waitMs,
      sharedProjection,
    );
    if (active) return active;
    const commandId = identity(
      "hold",
      canonical([this.core.hostId(), parent.threadId, requestId]),
    );
    await this.core.presentation.wakeBeforeDelivery(
      parent.threadId,
      identity("message", commandId),
    );
    this.core.state.update((state) => {
      const current = state.parents?.[parent.taskId];
      if (!current) return;
      current.holdingSince = new Date().toISOString();
      delete current.releasedAt;
    });
    await this.core.intents.effect(commandId, "orchestration.dispatchCommand", {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "server",
      commandId,
      threadId: parent.threadId,
      messageId: identity("message", commandId),
      text: HOLD_MARKER,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
    const deadline =
      Date.now() + (this.core.reentryTimeoutMs ?? REENTRY_TIMEOUT_MS);
    for (;;) {
      const run = await this.activeParentRun(parent.threadId);
      if (run) return run;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, REENTRY_POLL_MS));
    }
  }

  private async release(parent: ParentThread): Promise<void> {
    const acp = this.core.acp();
    if (!acp) return;
    acp.release(parent.sessionId, "no role child is running");
    this.core.state.update((state) => {
      const current = state.parents?.[parent.taskId];
      if (!current) return;
      current.releasedAt = new Date().toISOString();
      delete current.holdingSince;
    });
  }

  /** A create that just re-entered the parent is inside its grace window. */
  private holding(parent: ParentThread): boolean {
    if (!parent.holdingSince) return false;
    return Date.now() - Date.parse(parent.holdingSince) < HOLD_GRACE_MS;
  }

  private async archiveParent(parent: ParentThread): Promise<void> {
    if (
      this.core.intents.confirmedDeletion(
        this.core.state.read(),
        parent.threadId,
      )
    ) {
      this.forgetParent(parent.taskId);
      return;
    }
    const key = identity(
      "parent-archive",
      canonical([this.core.hostId(), parent.threadId]),
    );
    await this.core.intents.effect(key, "orchestration.dispatchCommand", {
      type: "thread.archive",
      commandId: key,
      threadId: parent.threadId,
    });
    this.core.state.update((state) => {
      const current = state.parents?.[parent.taskId];
      if (current) current.archivedAt = new Date().toISOString();
    });
  }

  // ---------------------------------------------------------------------- children

  /** Dispose one delegated task's completion delivery; a repeat is settled by a read. */
  private async dispose(parent: ParentThread, taskId: string): Promise<void> {
    const commandId = identity(
      "dispose",
      canonical([this.core.hostId(), parent.threadId, taskId]),
    );
    await this.core.intents.effect(
      commandId,
      "orchestration.dispatchCommand",
      {
        type: "delegated_task.completion-delivery.dispose",
        commandId,
        parentThreadId: parent.threadId,
        taskId,
      },
      undefined,
      undefined,
      { resendUnknownAfterRead: true },
    );
  }

  /**
   * Every wake this host still owes: a child whose delivery is `pending` or `claimed`
   * can still wake the parent agent, and the projection is the positive read that
   * makes a repeated dispose safe (same command id, an idempotent state, and the
   * nightly's receipt for a command it already ran).
   */
  private async disposePending(
    parent: ParentThread,
    projection: Projection,
  ): Promise<void> {
    for (const child of projection.subagents ?? []) {
      if (child.origin !== "app_owned") continue;
      const delivery = child.completionDelivery?.state;
      if (delivery !== "pending" && delivery !== "claimed") continue;
      await this.dispose(parent, child.id).catch((error) => {
        if (isHostOperationTimeout(error)) throw error;
      });
    }
  }

  /**
   * Whether any child of this task can still act. One complete inventory answers it:
   * a thread absent from that list, or listed as a `deletedAt` tombstone, is deleted (a
   * positive fact, never a read that failed), and a live one counts only while its
   * shell reports a live run. A deleted child must not hold the parent's turn forever
   * (nucleus#1305 review), and an inventory this host cannot read keeps the turn
   * rather than guessing.
   */
  private async anyChildLive(taskId: string): Promise<boolean> {
    const state = this.core.state.read();
    const ids = new Set(
      Object.entries(state.agents)
        .filter(
          ([id, agent]) =>
            labelTask(agent.labels) === taskId &&
            !this.core.intents.confirmedDeletion(state, id),
        )
        .map(([id]) => id),
    );
    if (!ids.size) return false;
    const shell = await this.core.reads.shell();
    // A deleted thread is either absent from the list or carried as a tombstone with
    // `deletedAt`; both are the same positive fact, and a tombstone with an old run
    // record must not read as live (nucleus#1305 review).
    return [...shell.threads, ...shell.archivedThreads].some(
      (thread) =>
        ids.has(thread.id) &&
        !thread.deletedAt &&
        (activeStatuses.has(thread.status) || thread.activeRunId !== null),
    );
  }

  /** The child thread T3 created for this command, when it exists after a lost reply. */
  private async adoptChild(
    parent: ParentThread,
    commandId: string,
  ): Promise<boolean> {
    const threadId = childThreadId(commandId);
    const known = await this.knownThread(threadId);
    if (!known || known.deletedAt) return false;
    let parentProjection: Projection;
    try {
      parentProjection = await this.core.reads.readDirectProjection(
        parent.threadId,
        "observation",
      );
    } catch (error) {
      if (isThreadNotFoundRpcError(error)) return false;
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
    if (
      !parentProjection?.subagents?.some(
        (child) =>
          child.childThreadId === threadId && child.origin === "app_owned",
      )
    )
      return false;
    await this.dispose(parent, childTaskId(commandId)).catch(() => undefined);
    return true;
  }

  private async knownThread(threadId: string) {
    const record = await this.core.reads.readThreadRecord(threadId);
    return record?.row ?? null;
  }

  /**
   * The parent launch's own check that T3 has no thread yet. A generic incomplete
   * read cannot prove absence, so the complete inventory answers it (nucleus#1460);
   * an unreadable inventory keeps the refusal. Child adoption keeps `knownThread`.
   */
  private async knownParentThread(taskId: string, threadId: string) {
    try {
      return await this.knownThread(threadId);
    } catch (error) {
      // Only a prepared launch (nothing reserved for a send) is settled by inventory.
      if (!(error instanceof T3TransientReadError) || this.parentLaunchReserved(taskId))
        throw error;
      const [row] = await this.inventoryRows(threadId, true);
      return row ?? null;
    }
  }

  /** The thread's rows in the complete paired inventory; an unreadable one is a transient refusal. */
  private async inventoryRows(threadId: string, fresh: boolean) {
    try {
      const inventory = fresh
        ? await this.core.reads.freshInventory()
        : await this.core.reads.inventory();
      return inventory.threads.filter((candidate) => candidate.id === threadId);
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
  }

  /**
   * The one prepared-versus-launched decision, shared by first dispatch, the retained
   * launch and owner restart (nucleus#1458, nucleus#1460). A binding is prepared when
   * the complete inventory has no row for it and no parent-launch intent was reserved:
   * nothing reached T3, so the stored binding is still the parent this task gets.
   */
  private preparedParent(
    taskId: string,
    observation: { kind: string; absent?: boolean },
  ): boolean {
    return (
      observation.kind === "deleted" &&
      observation.absent === true &&
      !this.parentLaunchReserved(taskId)
    );
  }

  private forgetParent(taskId: string): void {
    this.core.state.update((state) => {
      if (state.parents?.[taskId]) delete state.parents[taskId];
    });
  }

  /**
   * Observe one already-bound parent thread. Its narrow projection answers first.
   * A projection that cannot answer falls back to the complete paired inventory:
   * `ThreadNotFoundError`, and the generic incomplete read that the installed nightly
   * also gives for an absent thread (`OrchestrationV2GetThreadProjectionError`,
   * nucleus#1460). The generic error alone grants no absence; only the inventory can
   * prove it, and only for a prepared binding. A sent parent's generic read stays a
   * transient wait. An inventory that cannot be read is a transient refusal, never absence.
   */
  private async classifyParent(
    parent: ParentThread,
    fresh = false,
  ): Promise<
    | { kind: "live"; row: Projection["thread"]; projection: Projection }
    | {
        kind: "archived";
        row: Projection["thread"];
        projection: Projection | null;
      }
    /** `absent`: the complete inventory has no row for it, not a `deletedAt` tombstone. */
    | { kind: "deleted"; absent: boolean }
    | { kind: "mismatched" }
  > {
    const matchesParent = (candidate: {
      projectId: string;
      worktreePath: string | null;
      providerInstanceId: string;
      modelSelection: { instanceId: string };
    }) =>
      candidate.projectId === parent.projectId &&
      candidate.worktreePath === parent.directory &&
      candidate.providerInstanceId === PARENT_PROVIDER &&
      candidate.modelSelection.instanceId === PARENT_PROVIDER;
    try {
      const projection = await this.core.reads.readDirectProjection(
        parent.threadId,
        "observation",
        fresh,
      );
      const thread = projection.thread;
      if (thread.deletedAt) return { kind: "deleted", absent: false };
      if (!matchesParent(thread)) return { kind: "mismatched" };
      if (thread.archivedAt)
        return { kind: "archived", row: thread, projection };
      return { kind: "live", row: thread, projection };
    } catch (error) {
      if (isTransientT3ReadRpcError(error)) {
        // Only a prepared binding (nothing reserved for a send) may be settled by the
        // complete inventory. A sent parent keeps its transient wait, so churn never
        // turns its read into archive scans or a finished marker (nucleus#1451, #1460).
        if (this.parentLaunchReserved(parent.taskId))
          throw new T3TransientReadError(error);
      } else if (!isThreadNotFoundRpcError(error)) throw error;
    }
    const matches = await this.inventoryRows(parent.threadId, fresh);
    const thread = matches[0];
    if (
      matches.some(
        (candidate) =>
          candidate.archivedAt !== thread?.archivedAt ||
          candidate.deletedAt !== thread?.deletedAt,
      )
    )
      throw Error("T3Code parent inventory has conflicting observations");
    if (!thread || thread.deletedAt)
      return { kind: "deleted", absent: !thread };
    if (matches.some((candidate) => !matchesParent(candidate)))
      return { kind: "mismatched" };
    if (thread.archivedAt)
      return { kind: "archived", row: thread, projection: null };
    try {
      return {
        kind: "live",
        row: thread,
        projection: await this.core.reads.readDirectProjection(
          parent.threadId,
          "observation",
        ),
      };
    } catch (error) {
      if (isTransientT3ReadRpcError(error))
        throw new T3TransientReadError(error);
      throw error;
    }
  }

  /**
   * Whether this task's parent thread is finished: `archived`, or deleted (absent from
   * the complete inventory, or carried there as a `deletedAt` tombstone). Null means it
   * is still readable and registered.
   */
  private async parentGone(
    parent: ParentThread,
  ): Promise<"archived" | "deleted" | "mismatched" | null> {
    const classified = await this.classifyParent(parent, true);
    return classified.kind === "live" ? null : classified.kind;
  }

  /**
   * Record a parent this task will not use again, so the sweep leaves it alone and
   * later roles refuse with the reason instead of re-launching a parent that would
   * orphan this task's children.
   */
  private finishParent(taskId: string, why: "archived" | "deleted"): void {
    this.core.state.update((state) => {
      const current = state.parents?.[taskId];
      if (current) current.archivedAt ??= new Date().toISOString();
      state.nesting = {
        state: "unavailable",
        reason: `the task's parent thread is ${why}`,
        at: new Date().toISOString(),
      };
    });
  }

  // ---------------------------------------------------------------------- refusals

  /**
   * One role create this host cannot make: record why on the host status and answer
   * the reason the task shows. Nothing was sent and nothing is launched — the task
   * waits visibly with the reason and the fix (nucleus#1366).
   */
  private unavailable(taskId: string, reason: string): NestedCreateResult {
    this.core.state.update((state) => {
      state.nesting = {
        state: "unavailable",
        reason,
        at: new Date().toISOString(),
      };
    });
    return { ok: false, reason };
  }
}
