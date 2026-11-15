import { taskControlInputSchema, type Task, type TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { ownerEffectIdentity } from "./owner-effects";

/**
 * The three replay answers: a `retry_effect` replayed after its own effect
 * already landed is answered by the recorded outcome, never re-sent. The
 * persisted operation, not the caller, is the identity — the stored control must
 * be this exact request, and the settled evidence must be recorded after the
 * operation was accepted.
 */
export class RetryEffectReplay {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }

  /**
   * The accepted invocation of this exact request, or null. A running
   * task-control operation whose stored control names the same task, effect,
   * expected version and caller is the same call arriving twice.
   */
  private acceptedInvocation(task: Task, input: TaskControlInput, operationId: string | undefined,
    matches: (stored: TaskControlInput) => boolean): { acceptedAt: number } | null {
    if (!operationId) return null;
    const invocation = this.store.operation(operationId);
    if (!invocation || invocation.kind !== 'task_control' || invocation.taskId !== task.id
      || invocation.state !== 'running' || invocation.expectedVersion !== input.version) return null;
    const stored = taskControlInputSchema.safeParse((this.store.operationPayload(operationId) as { control?: unknown } | null)?.control);
    if (!stored.success || stored.data.taskId !== task.id || stored.data.action !== 'retry_effect'
      || stored.data.effect !== input.effect || stored.data.version !== input.version
      || stored.data.caller !== input.caller || !matches(stored.data)) return null;
    return { acceptedAt: Date.parse(invocation.createdAt) };
  }

  /**
   * A replayed terminal archive retry (service restart) whose own archive has
   * already landed is answered by that recorded outcome, its original decision,
   * not refused as stale: the exact running operation, its expected version, the
   * workspace in archivedWorkspaceIds, and an event recorded after the operation
   * was accepted. Chronology alone is not identity: an event strictly after
   * acceptance must name this workspace (its archive, its recorded content
   * discard or its cancelled-retirement archive record), and that workspace's
   * archive must follow it. Nothing is re-enqueued.
   */
  replayedArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    const workspaceId = input.effect ? ownerEffectIdentity(input.effect, 'workspace_archive') : null;
    if (!workspaceId || !task.resolution.archivedWorkspaceIds.includes(workspaceId)) return null;
    const accepted = this.acceptedInvocation(task, input, operationId, () => true);
    if (!accepted) return null;
    const after = this.store.eventsAll(task.id).filter(event => Date.parse(event.at) > accepted.acceptedAt);
    const recordNames = (event: { kind: string; detail: string }, kind: string) => {
      if (event.kind !== kind) return false;
      try { return (JSON.parse(event.detail) as { workspaceId?: unknown }).workspaceId === workspaceId; } catch { return false; }
    };
    const archived = (event: { kind: string; detail: string }) => event.kind === 'workspace_archived'
      ? event.detail.split('; ').includes(`workspace ${workspaceId}`) : recordNames(event, 'workspace_retirement_archived');
    const names = (event: { kind: string; detail: string }) => archived(event)
      || event.kind === 'workspace_contents_discarded' && recordNames(event, 'workspace_contents_discarded');
    const named = after.findIndex(names);
    if (named < 0) return null;
    return after.slice(named).some(archived) ? task : null;
  }

  /** A replayed `retry_effect` for a catalog archive that already settled is answered by its record (Spec 017). */
  replayedCatalogArchiveOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    const workspaceId = input.effect ? ownerEffectIdentity(input.effect, 'external_workspace_archive') : null;
    if (!workspaceId) return null;
    const record = task.resolution.externalWorkspaceArchives.find(item => item.workspaceId === workspaceId);
    if (record?.state !== 'archived') return null;
    const accepted = this.acceptedInvocation(task, input, operationId, () => true);
    if (!accepted) return null;
    return this.store.eventsAll(task.id).some(event => {
      if (event.kind !== 'external_workspace_archive_archived' || Date.parse(event.at) <= accepted.acceptedAt) return false;
      try { return (JSON.parse(event.detail) as { workspaceId?: string }).workspaceId === workspaceId; } catch { return false; }
    }) ? task : null;
  }

  /**
   * A replayed `retry_effect` for a disposition workspace step that has since
   * settled is answered by the settled disposition, never re-run. The stored
   * control must also name the same work-disposition policy, and the disposition
   * must have completed after that acceptance. A stale version without that
   * proof still refuses as stale.
   */
  replayedDispositionWorkspaceOutcome(task: Task, input: TaskControlInput, operationId?: string): Task | null {
    if (!input.effect?.startsWith('disposition_workspace.')) return null;
    const accepted = this.acceptedInvocation(task, input, operationId, stored => stored.workDisposition === input.workDisposition);
    if (!accepted || task.disposition?.status !== 'complete') return null;
    return this.store.eventsAll(task.id).some(event => event.kind === 'disposition_complete' && Date.parse(event.at) > accepted.acceptedAt)
      ? task : null;
  }
}
