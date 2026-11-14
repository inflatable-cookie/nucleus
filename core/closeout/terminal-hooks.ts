import type { Task } from '../../shared/contracts';
import type { Store } from '../store/store';
import type { RepositoryHooks } from '../hooks/hooks';
import { sweepTaskHostProcesses } from '../machine/host-process-reap';

/** The store and hook owner a terminal task's finished hook and process sweep read. */
export interface TerminalHookContext {
  readonly store: Store;
  readonly hooks: Pick<RepositoryHooks, 'finished'>;
}

/**
 * The advisory finished-task hook. It is owed once per terminal transition and
 * its failure is recorded, never thrown: an archive or cleanup pass must not
 * fail because a repository hook did not run.
 */
export async function runFinishedHook(ctx: TerminalHookContext, task: Task): Promise<void> {
  try { await ctx.hooks.finished(ctx.store.task(task.id)); }
  catch (error) { ctx.store.event(task.id, 'finished_hook_warning', `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`); }
}

/**
 * The terminal pair: the finished hook, then the host-process sweep. Every
 * terminal path runs them in this order with this isolation, so a warning in
 * one never skips the other or fails the pass.
 */
export async function runTerminalHooks(ctx: TerminalHookContext, task: Task): Promise<void> {
  await runFinishedHook(ctx, task);
  try { await sweepTaskHostProcesses(ctx.store, ctx.store.task(task.id)); }
  catch (error) { ctx.store.event(task.id, 'host_process_sweep_warning', `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`); }
}
