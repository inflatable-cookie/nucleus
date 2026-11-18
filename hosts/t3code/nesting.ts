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
 *   and starts it at once. That is why a role whose run needs a *different* checkout
 *   stays a top-level thread: the fallback, never a silent re-home.
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
import { z } from 'zod';
import type { HostAgentAttempt, HostAgentSpec } from '../../shared/host';
import type { Profile, Task } from '../../shared/contracts';
import type { AcpSessionSurface } from '../../shared/acp/surface';
import { ProvenPreSendRefusalError } from '../../core/host';
import type { T3RpcClient } from './rpc';
import { config, type RuntimeMode } from './contracts';
import { activeStatuses, type Projection, type T3Reads } from './reads';
import { identity, type T3IntentLedger } from './intents';
import { canonical, type T3State, type T3StateFile } from './state';
import { labelTask } from './one-row';

/**
 * The provider instance an operator registers in T3's settings, the model the Nucleus
 * ACP agent advertises, and the nightly's driver name for such a provider. All three
 * are Nucleus's own constants, never read from remote text: T3 has no schema discovery,
 * so a mismatch is refused with guidance rather than guessed at.
 */
export const PARENT_PROVIDER = 'nucleus';
export const PARENT_MODEL = 'nucleus';
export const PARENT_DRIVER = 'acpRegistry';

/**
 * The marker in every re-entry prompt this module sends. The binding's `holdPattern`
 * names it, so the ACP agent holds that turn and forwards nothing: exactly one place
 * decides what a person is, and it is configuration, never parsed remote text.
 */
export const HOLD_MARKER = 'nucleus-hold-the-task-thread';

/**
 * T3's own wordings for text that is not a person speaking to a task: a delegated
 * task's completion wake (all of the nightly's wordings carry the derived task-id
 * prefix) and the note it starts a restart continuation run with. The binding's
 * `ignorePattern` names them, so even a lost dispose never puts remote text into the
 * task's message log. These are this adapter's constants — anchored substrings, never
 * parsed remote structure.
 */
export const T3_NOTICE_PHRASES = [
  'Delegated task node:delegated-task:',
  'Cancelled because the server restarted',
  'Cancelled because the server shut down',
] as const;

/** The prompt rules a launched ACP agent reads from its binding. */
export const parentPromptRules = (): { ignorePattern: string; holdPattern: string } => ({
  ignorePattern: T3_NOTICE_PHRASES.map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  holdPattern: HOLD_MARKER,
});

/** The child thread a delegated-task command creates (nightly `idAllocator.derive`). */
export const childThreadId = (commandId: string): string => `thread:delegated-task:${commandId}`;
/** The delegated task node the same command creates; the id a dispose names. */
export const childTaskId = (commandId: string): string => `node:delegated-task:${commandId}`;

/** How long a re-entry waits for the parent's run to appear before the path falls back. */
export const REENTRY_TIMEOUT_MS = 20_000;
/** How long a just-launched parent gets to show its run before it counts as released. */
const LAUNCH_RUN_TIMEOUT_MS = 5_000;
const REENTRY_POLL_MS = 500;
/** A child create right after a re-entry is protected from a concurrent release sweep. */
const HOLD_GRACE_MS = 60_000;
/** After a child this host could not create, the task's next roles go straight to the fallback. */
const FALLBACK_PARK_MS = 10 * 60_000;

type ConfigModel = z.infer<typeof config>['providers'][number]['models'][number];
type ConfigProvider = z.infer<typeof config>['providers'][number];
type ParentThread = NonNullable<T3State['parents']>[string];

export interface T3NestingContext {
  rpc: T3RpcClient;
  state: T3StateFile;
  reads: T3Reads;
  intents: T3IntentLedger;
  /** The one presentation call a re-entry needs: a settled thread does not start a run. */
  presentation: { unsettleBeforeMessage(threadId: string, messageId: string): Promise<void> };
  hostId(): string;
  requireConnection(): void;
  /** The service's ACP session surface; absent in a process that serves no ACP sessions. */
  acp(): AcpSessionSurface | null;
  /** The profile's model options, from the launch's own config read (the host's fence). */
  modelSelectionOptions(profile: Profile, model: ConfigModel | undefined): Array<{ id: string; value: string | boolean }>;
  /** The profile's runtime mode as one provider offers it (the host's fence). */
  runtimeMode(profile: Profile, supported: readonly RuntimeMode[] | undefined): RuntimeMode;
  /** A re-entry's bounded wait for the parent's run; the product default unless overridden. */
  reentryTimeoutMs?: number;
}

/** One create this module may own: everything the launch already read, plus the child's identity. */
export interface NestedCreateInput {
  spec: HostAgentSpec;
  attempt: HostAgentAttempt;
  profile: Profile;
  workspace: { id: string; projectId: string; directory: string };
  /** The launch's one `server.getConfig` read. */
  observed: z.infer<typeof config>;
  /** The child's title, already numbered by the host. */
  title: string;
}

export class T3Nesting {
  constructor(private readonly core: T3NestingContext) {}

  /** The parent record of one task, when this host is nesting it. */
  parentOf(taskId: string): ParentThread | undefined { return this.core.state.read().parents?.[taskId]; }

  /** Whether this thread is a task's parent thread (never a child, never a run's agent). */
  isParent(threadId: string): boolean {
    return Object.values(this.core.state.read().parents ?? {}).some(parent => parent.threadId === threadId);
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
    return state.parents?.[taskId]?.threadId === agent.parentThreadId ? taskId : undefined;
  }

  /** What the host status reports: whether this host is nesting, or why it is not. */
  statusLine(): string {
    const nesting = this.core.state.read().nesting;
    if (!nesting) return 'native parenting not used yet';
    return nesting.state === 'nested' ? 'native parenting on the nucleus ACP provider' : `native parenting off: ${nesting.reason}`;
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
      this.core.state.update(state => { state.nesting = { state: 'fallback', reason: 'this process serves no ACP sessions', at }; });
      return;
    }
    const provider = this.parentProvider(observed);
    this.core.state.update(state => {
      state.nesting = provider.ok ? { state: 'nested', reason: '', at } : { state: 'fallback', reason: provider.reason, at };
    });
  }

  /**
   * Create one role thread as a child of the task's parent, or answer null when this
   * task must fall back to a top-level role thread. A null answer means *nothing was
   * sent*: every reason is proven before the child command, and a child command whose
   * outcome is unknown is resolved by reading the deterministic child id first.
   */
  async create(input: NestedCreateInput): Promise<{ id: string; workspaceId: string } | null> {
    const taskId = labelTask(input.attempt.labels);
    if (!taskId) return this.degrade('', 'the launch names no task');
    if (this.parked(taskId)) return null;
    const acp = this.core.acp();
    if (!acp) return this.degrade(taskId, `this process serves no ACP sessions, so the ${PARENT_PROVIDER} provider has nothing to run`);
    const provider = this.parentProvider(input.observed);
    if (!provider.ok) return this.degrade(taskId, provider.reason);
    const existing = this.parentOf(taskId);
    if (existing) {
      // A role whose run needs another checkout cannot be a child: a child with no
      // workspace strategy inherits the parent's worktree, and one with a strategy never
      // starts outside T3's own MCP handler. Such a role stays a top-level thread.
      if (existing.workspaceId !== input.workspace.id) return null;
      // A parent that is finished (archived, or gone from a complete inventory) is not
      // re-launched: its task works the rest of its roles as top-level threads. A
      // second parent thread would orphan this task's children and re-mint its binding.
      if (existing.archivedAt) return null;
      const gone = await this.parentGone(existing).catch(() => null);
      if (gone) { this.finishParent(taskId, gone); return null; }
      // The create owns the turn from here: a concurrent sweep must not release it
      // between the parent-run read and the child command.
      this.core.state.update(state => {
        const current = state.parents?.[taskId];
        if (current) current.holdingSince = new Date().toISOString();
      });
    }
    const parent = existing ?? await this.launchParent(input, provider, acp);
    if (!parent) return null;
    const commandId = identity('child', canonical([this.core.hostId(), input.attempt.requestId]));
    const threadId = childThreadId(commandId);
    // A parent this launch just created starts its run asynchronously; one that
    // already existed and lost its turn needs the re-entry at once.
    const live = await this.heldRun(parent, input.attempt.requestId, existing ? 0 : LAUNCH_RUN_TIMEOUT_MS);
    if (!live) return this.park(taskId, 'the parent thread did not reach a live run');
    const options = this.core.modelSelectionOptions(input.profile, provider.model);
    const runtimeMode = this.core.runtimeMode(input.profile, provider.supportedRuntimeModes);
    const payload = {
      type: 'delegated_task.request', createdBy: 'user', creationSource: 'server', commandId,
      parentThreadId: parent.threadId, parentRunId: live.id, parentNodeId: live.rootNodeId,
      task: input.attempt.prompt, title: input.title,
      modelSelection: { instanceId: input.profile.provider, model: input.profile.model, ...(options.length ? { options } : {}) },
      runtimeMode, interactionMode: 'default',
      // Belt and braces beside the dispose below: a `settled_only` child never wakes a
      // live parent, even if this process dies before that dispose lands.
      completionWake: 'settled_only',
    };
    // Record the child's identity before the send, so a lost reply cannot produce an
    // unowned thread: the id is derived from the command id, never from an answer.
    this.core.state.update(state => {
      const old = state.agents[threadId], record = { id: threadId, workspaceId: input.workspace.id, labels: input.attempt.labels };
      if (old && canonical({ id: old.id, workspaceId: old.workspaceId, labels: old.labels }) !== canonical(record))
        throw new ProvenPreSendRefusalError('T3Code retained identity changed');
      state.agents[threadId] = { ...old, ...record, title: input.title, parentThreadId: parent.threadId };
      // A child created again on a thread id this host had retired is observed again.
      delete state.retiredAgents?.[threadId];
    });
    try {
      await this.core.intents.effect(commandId, 'orchestration.dispatchCommand', payload, () => {
        if (input.spec.guard && !input.spec.guard.stillAllowed())
          throw new ProvenPreSendRefusalError('T3Code launch guard changed');
      });
    } catch (error) {
      if (await this.adoptChild(parent, commandId)) return { id: threadId, workspaceId: input.workspace.id };
      if (!(error instanceof ProvenPreSendRefusalError)) {
        this.core.state.update(state => { delete state.agents[threadId]; });
        throw error;
      }
      this.core.state.update(state => { delete state.agents[threadId]; });
      return this.park(taskId, 'the child was refused before delivery');
    }
    this.core.state.update(state => { const record = state.parents?.[taskId]; if (record) delete record.releasedAt; });
    await this.dispose(parent, childTaskId(commandId)).catch(() => undefined);
    return { id: threadId, workspaceId: input.workspace.id };
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
      if (task.removedAt != null || task.phase === 'done' || task.phase === 'cancelled') {
        await this.archiveParent(parent).catch(() => undefined);
        continue;
      }
      // A parent that left observation is read no further: its task is over, and the
      // archive above is the whole remaining work for it (nucleus#1328).
      if (!this.core.reads.observes(parent.threadId)) continue;
      let projection: Projection;
      try { projection = await this.core.reads.readProjection(parent.threadId, 'observation'); } catch { continue; }
      if (projection.thread.deletedAt) { this.forgetParent(task.id); continue; }
      await this.disposePending(parent, projection);
      if (projection.thread.archivedAt) continue;
      if (!projection.runs.some(run => activeStatuses.has(run.status))) continue;
      if (this.holding(parent)) continue;
      if (await this.anyChildLive(task.id)) continue;
      await this.release(parent);
    }
  }

  // ---------------------------------------------------------------- parent thread

  /** The provider instance, model and offered runtime modes a parent launch needs. */
  private parentProvider(observed: z.infer<typeof config>):
    | { ok: true; model: ConfigModel; supportedRuntimeModes?: readonly RuntimeMode[] }
    | { ok: false; reason: string } {
    const provider: ConfigProvider | undefined = observed.providers.find(candidate => candidate.instanceId === PARENT_PROVIDER);
    if (!provider)
      return { ok: false, reason: `T3Code has no ${PARENT_PROVIDER} ACP provider instance; register the installed nucleus-acp command as an ACP provider named ${PARENT_PROVIDER}` };
    if (provider.driver !== undefined && provider.driver !== PARENT_DRIVER)
      return { ok: false, reason: `T3Code provider ${PARENT_PROVIDER} is not an ACP provider (the ${PARENT_DRIVER} driver)` };
    if (!provider.enabled || provider.status !== 'ready')
      return { ok: false, reason: `T3Code provider ${PARENT_PROVIDER} is not ready` };
    const model = provider.models.find(candidate => candidate.slug === PARENT_MODEL) ?? provider.models[0];
    if (!model) return { ok: false, reason: `T3Code provider ${PARENT_PROVIDER} reports no model; the Nucleus ACP agent advertises ${PARENT_MODEL}` };
    return { ok: true, model, supportedRuntimeModes: provider.supportedRuntimeModes };
  }

  /**
   * The task's parent thread, launched on the Nucleus ACP provider, or a proven refusal.
   * The binding is minted first, because the launched agent resolves its session from
   * the checkout it starts in; the thread id is deterministic, so a lost reply is
   * settled by finding the thread, and only a proven absence launches it again under
   * the same command identity.
   */
  private async launchParent(input: NestedCreateInput,
    provider: { ok: true; model: ConfigModel; supportedRuntimeModes?: readonly RuntimeMode[] },
    acp: AcpSessionSurface): Promise<ParentThread | null> {
    const taskId = labelTask(input.attempt.labels)!;
    const threadId = identity('thread', canonical([this.core.hostId(), taskId, 'parent']));
    const binding = acp.bind({ taskId, ...parentPromptRules() });
    const record: ParentThread = {
      taskId, threadId, sessionId: binding.sessionId, bindingPath: binding.bindingPath,
      workspaceId: input.workspace.id, projectId: input.workspace.projectId, directory: input.workspace.directory,
      createdAt: new Date().toISOString(), title: input.title,
    };
    // Durable before the send: a lost reply leaves an owned parent, never an orphan.
    this.core.state.update(state => {
      const old = state.parents?.[taskId];
      if (old && (old.threadId !== threadId || old.sessionId !== binding.sessionId))
        throw new ProvenPreSendRefusalError('T3Code parent thread identity changed');
      state.parents = { ...state.parents, [taskId]: old ?? record };
      state.nesting = { state: 'nested', reason: '', at: new Date().toISOString() };
    });
    const known = await this.knownThread(threadId).catch(() => null);
    if (known) {
      if (known.deletedAt) return null;
      this.core.state.update(state => {
        const current = state.parents?.[taskId];
        if (current) state.parents![taskId] = { ...current, ...record };
      });
      return this.parentOf(taskId) ?? record;
    }
    const offered = provider.supportedRuntimeModes ?? [];
    const runtimeMode: RuntimeMode = offered.length === 0 || offered.includes('full-access') ? 'full-access' : 'approval-required';
    const commandId = identity('parent-launch', canonical([this.core.hostId(), taskId]));
    const payload = {
      commandId, threadId, projectId: input.workspace.projectId, title: record.title ?? PARENT_PROVIDER,
      modelSelection: { instanceId: PARENT_PROVIDER, model: provider.model.slug }, runtimeMode, interactionMode: 'default',
      workspaceStrategy: { type: 'existing_worktree', worktreePath: input.workspace.directory },
      // The opening prompt is never forwarded by the ACP agent (Spec 065): it
      // establishes the thread and holds the turn, and the agent shows the task's
      // lifecycle rather than inventing anything of its own.
      initialMessage: { messageId: identity('message', commandId), text: `${HOLD_MARKER}: ${taskId}`, attachments: [] },
    };
    await this.core.intents.effect(commandId, 'orchestration.launchThread', payload, undefined, undefined, { resendUnknownAfterRead: true });
    if (this.core.reads.threadShapePending) await this.core.reads.readProjection(threadId, 'observation').catch(() => undefined);
    return this.parentOf(taskId) ?? record;
  }

  /** A parent run that can carry a child: live, and naming its own root node. */
  private async activeParentRun(threadId: string, waitMs = 0): Promise<{ id: string; rootNodeId: string } | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      let projection: Projection;
      try { projection = await this.core.reads.readProjection(threadId, 'observation'); }
      catch { return null; }
      if (projection.thread.deletedAt) return null;
      const runs = projection.runs.filter(run => activeStatuses.has(run.status) && typeof run.rootNodeId === 'string' && run.rootNodeId);
      const latest = runs.sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1)).at(-1);
      if (latest) return { id: latest.id, rootNodeId: latest.rootNodeId! };
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, REENTRY_POLL_MS));
    }
  }

  /**
   * The parent's live run, re-entered if it has none. A held turn is what makes a
   * child creatable, so "no active run" means "re-arm the thread, then wait for T3 to
   * start it". The wait is bounded: a parent T3 will not run is a proven reason to
   * keep the task working on a top-level thread.
   */
  private async heldRun(parent: ParentThread, requestId: string, waitMs = 0): Promise<{ id: string; rootNodeId: string } | null> {
    const active = await this.activeParentRun(parent.threadId, waitMs);
    if (active) return active;
    const commandId = identity('hold', canonical([this.core.hostId(), parent.threadId, requestId]));
    await this.core.presentation.unsettleBeforeMessage(parent.threadId, identity('message', commandId)).catch(() => undefined);
    this.core.state.update(state => {
      const current = state.parents?.[parent.taskId];
      if (!current) return;
      current.holdingSince = new Date().toISOString();
      delete current.releasedAt;
    });
    await this.core.intents.effect(commandId, 'orchestration.dispatchCommand', {
      type: 'message.dispatch', createdBy: 'user', creationSource: 'server', commandId, threadId: parent.threadId,
      messageId: identity('message', commandId), text: `${HOLD_MARKER}: ${parent.taskId}`, attachments: [],
      dispatchMode: { type: 'queue_after_active' },
    });
    const deadline = Date.now() + (this.core.reentryTimeoutMs ?? REENTRY_TIMEOUT_MS);
    for (;;) {
      const run = await this.activeParentRun(parent.threadId);
      if (run) return run;
      if (Date.now() >= deadline) return null;
      await new Promise(resolve => setTimeout(resolve, REENTRY_POLL_MS));
    }
  }

  private async release(parent: ParentThread): Promise<void> {
    const acp = this.core.acp();
    if (!acp) return;
    acp.release(parent.sessionId, 'no role child is running');
    this.core.state.update(state => {
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
    if (this.core.intents.confirmedDeletion(this.core.state.read(), parent.threadId)) { this.forgetParent(parent.taskId); return; }
    const key = identity('parent-archive', canonical([this.core.hostId(), parent.threadId]));
    await this.core.intents.effect(key, 'orchestration.dispatchCommand', { type: 'thread.archive', commandId: key, threadId: parent.threadId });
    this.core.state.update(state => {
      const current = state.parents?.[parent.taskId];
      if (current) current.archivedAt = new Date().toISOString();
    });
  }

  // ---------------------------------------------------------------------- children

  /** Dispose one delegated task's completion delivery; a repeat is settled by a read. */
  private async dispose(parent: ParentThread, taskId: string): Promise<void> {
    const commandId = identity('dispose', canonical([this.core.hostId(), parent.threadId, taskId]));
    await this.core.intents.effect(commandId, 'orchestration.dispatchCommand',
      { type: 'delegated_task.completion-delivery.dispose', commandId, parentThreadId: parent.threadId, taskId },
      undefined, undefined, { resendUnknownAfterRead: true });
  }

  /**
   * Every wake this host still owes: a child whose delivery is `pending` or `claimed`
   * can still wake the parent agent, and the projection is the positive read that
   * makes a repeated dispose safe (same command id, an idempotent state, and the
   * nightly's receipt for a command it already ran).
   */
  private async disposePending(parent: ParentThread, projection: Projection): Promise<void> {
    for (const child of projection.subagents ?? []) {
      if (child.origin !== 'app_owned') continue;
      const delivery = child.completionDelivery?.state;
      if (delivery !== 'pending' && delivery !== 'claimed') continue;
      await this.dispose(parent, child.id).catch(() => undefined);
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
    const ids = new Set(Object.entries(state.agents)
      .filter(([id, agent]) => labelTask(agent.labels) === taskId && !this.core.intents.confirmedDeletion(state, id))
      .map(([id]) => id));
    if (!ids.size) return false;
    const { threads } = await this.core.reads.inventory();
    // A deleted thread is either absent from the list or carried as a tombstone with
    // `deletedAt`; both are the same positive fact, and a tombstone with an old run
    // record must not read as live (nucleus#1305 review).
    return threads.some(thread => ids.has(thread.id) && !thread.deletedAt
      && (activeStatuses.has(thread.status) || thread.activeRunId !== null));
  }

  /** The child thread T3 created for this command, when it exists after a lost reply. */
  private async adoptChild(parent: ParentThread, commandId: string): Promise<boolean> {
    const threadId = childThreadId(commandId);
    const known = await this.knownThread(threadId).catch(() => null);
    if (!known || known.deletedAt) return false;
    const parentProjection = await this.core.reads.readProjection(parent.threadId, 'observation').catch(() => null);
    if (!parentProjection?.subagents?.some(child => child.childThreadId === threadId && child.origin === 'app_owned')) return false;
    await this.dispose(parent, childTaskId(commandId)).catch(() => undefined);
    return true;
  }

  private async knownThread(threadId: string) {
    const { threads } = await this.core.reads.inventory();
    return threads.find(thread => thread.id === threadId) ?? null;
  }

  private forgetParent(taskId: string): void {
    this.core.state.update(state => { if (state.parents?.[taskId]) delete state.parents[taskId]; });
  }

  /**
   * Whether this task's parent thread is finished: `archived`, or deleted (absent from
   * the complete inventory, or carried there as a `deletedAt` tombstone). Null means it
   * is still readable and registered.
   */
  private async parentGone(parent: ParentThread): Promise<'archived' | 'deleted' | null> {
    const { threads } = await this.core.reads.inventory();
    const thread = threads.find(candidate => candidate.id === parent.threadId);
    // Absence and a `deletedAt` tombstone are the same fact: the inventory either
    // omits a removed thread or keeps its tombstone (nucleus#1305 review).
    if (!thread || thread.deletedAt) return 'deleted';
    return thread.archivedAt ? 'archived' : null;
  }

  /**
   * Record a parent this task will not use again, so later roles fall back at once and
   * the sweep leaves it alone. The record stays: it is how the host remembers that a
   * role of this task is a fallback thread rather than a child.
   */
  private finishParent(taskId: string, why: 'archived' | 'deleted'): void {
    this.core.state.update(state => {
      const current = state.parents?.[taskId];
      if (current) current.archivedAt ??= new Date().toISOString();
      state.nesting = { state: 'fallback', reason: `the task parent thread is ${why}`, at: new Date().toISOString() };
    });
  }

  // ---------------------------------------------------------------------- fallbacks

  /** Enough of the fallback to be visible on the host status, without touching the task. */
  private degrade(taskId: string, reason: string): null {
    this.core.state.update(state => { state.nesting = { state: 'fallback', reason, at: new Date().toISOString() }; });
    if (taskId) this.parkUntil(taskId);
    return null;
  }

  /** Park the native path for this task after a child this host could not complete. */
  private park(taskId: string, reason: string): null {
    this.core.state.update(state => { state.nesting = { state: 'fallback', reason, at: new Date().toISOString() }; });
    this.parkUntil(taskId);
    return null;
  }

  private parkUntil(taskId: string): void {
    this.core.state.update(state => {
      const parent = state.parents?.[taskId];
      if (parent) parent.fallbackUntil = new Date(Date.now() + FALLBACK_PARK_MS).toISOString();
    });
  }

  private parked(taskId: string): boolean {
    const until = this.parentOf(taskId)?.fallbackUntil;
    return until !== undefined && Date.parse(until) > Date.now();
  }
}
