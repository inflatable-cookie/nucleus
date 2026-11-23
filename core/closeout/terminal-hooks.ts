import type { Task } from "../../shared/contracts";
import type { Store } from "../store/store";
import type { RepositoryHooks } from "../hooks/hooks";
import type { HostProcessFact } from "../host/types";
import { sweepTaskHostProcesses } from "../machine/host-process-reap";
import { currentTaskQuantumScope } from "../scheduling/pass-snapshot";

/** The store and hook owner a terminal task's finished hook and process sweep read. */
export interface TerminalHookContext {
  readonly store: Store;
  readonly hooks: Pick<RepositoryHooks, "finished">;
  readonly adapter?: {
    hostProcessListing?: () => Promise<HostProcessFact[] | null>;
  };
}

/**
 * The advisory finished-task hook. It is owed once per terminal transition and
 * its failure is recorded, never thrown: an archive or cleanup pass must not
 * fail because a repository hook did not run.
 */
export async function runFinishedHook(
  ctx: TerminalHookContext,
  task: Task,
): Promise<void> {
  try {
    await ctx.hooks.finished(ctx.store.task(task.id));
  } catch (error) {
    ctx.store.event(
      task.id,
      "finished_hook_warning",
      `task.finished could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The terminal pair: the finished hook, then the host-process sweep. Every
 * terminal path runs them in this order with this isolation, so a warning in
 * one never skips the other or fails the pass.
 */
export async function runTerminalHooks(
  ctx: TerminalHookContext,
  task: Task,
): Promise<void> {
  await runFinishedHook(ctx, task);
  const scope = currentTaskQuantumScope();
  if (scope?.inTaskQuantum) {
    // Spec 068 §6: never start a full host process scan inside a task quantum.
    // Reuse the pass's cached process table when available, otherwise leave
    // the recorded hostProcessSweep intent for the host cleanup lane.
    const latest = ctx.store.task(task.id);
    const cached =
      latest.hostId && scope.snapshot
        ? await scope.snapshot.processes(
            latest.hostId,
            async () => ({
              state: "unknown" as const,
              reason: "no host-pass process snapshot",
            }),
            0,
            { cacheOnly: true },
          )
        : null;
    if (!cached || cached.state !== "listed") return;
    try {
      await sweepTaskHostProcesses(ctx.store, latest, {
        readProcesses: async () => cached.processes,
      });
    } catch (error) {
      ctx.store.event(
        task.id,
        "host_process_sweep_warning",
        `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  try {
    await sweepTaskHostProcesses(ctx.store, ctx.store.task(task.id), {
      readProcesses: ctx.adapter?.hostProcessListing
        ? () => ctx.adapter!.hostProcessListing!()
        : undefined,
    });
  } catch (error) {
    ctx.store.event(
      task.id,
      "host_process_sweep_warning",
      `Host process sweep could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
