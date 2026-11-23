import type { Run, Task } from '../../shared/contracts';
import { recordedTicketMatchesLeaf, ticketTemporaryDirectoryBeside } from '../workspaces/run-scratch';

export function runWorkspaceDirectory(task: Task | null, run: Run | null | undefined): string | null {
  return run?.reviewSourceView?.directory ??
    (task && (!run || run.workspaceId === task.workspaceId) ? task.directory : null);
}

/**
 * The temporary root one participant run ticket ran with, or undefined when this
 * task records none.
 *
 * A run row records its own leaf. The retained worker's ticket is the task's
 * recorded leaf. A retired worker's record names the worker ticket a replacement
 * displaced: it has no run row and no recorded leaf of its own, so its leaf is the
 * one its identity names beside the task's recorded leaf — the launcher's own rule
 * (`ticketTemporaryDirectoryBeside`). That is the root its processes were started
 * under, so the owned-tool and workspace proofs can scan it instead of calling it
 * unrecorded.
 *
 * A retired ticket this task recorded on another host, a ticket this task never
 * recorded, and a recorded leaf in no shape Queue writes all stay unrecorded: the
 * proof refuses with its own reason rather than borrowing an unrelated root.
 */
export function participantTemporaryDirectory(task: Task, runs: Run[], runId: string): string | undefined {
  const run = runs.find(item => item.id === runId);
  if (run) return run.temporaryDirectory || (run.id === task.runId ? task.temporaryDirectory || undefined : undefined);
  if (runId === task.runId) return task.temporaryDirectory || undefined;
  const retiredHere = task.retiredWorkers.some(worker => worker.runId === runId && (worker.hostId ?? task.hostId) === task.hostId);
  if (!retiredHere || !task.temporaryDirectory) return undefined;
  if (recordedTicketMatchesLeaf(task.temporaryDirectory, runId)) return task.temporaryDirectory;
  const tickets = [
    task.runId,
    ...runs.filter(item => item.hostId === task.hostId).map(item => item.id),
    ...task.retiredWorkers.filter(worker => (worker.hostId ?? task.hostId) === task.hostId).map(worker => worker.runId),
  ].filter((id): id is string => Boolean(id));
  for (const ticket of new Set(tickets)) {
    const matched = ticketTemporaryDirectoryBeside(task.temporaryDirectory, ticket, runId);
    if (matched) return matched;
  }
  return undefined;
}
