/**
 * The ready-report refusals and the queue branch name shape.
 *
 * A checkout or PR-identity refusal carries its own code, so the caller that
 * returns the report to its worker reads a typed fact instead of matching this
 * module's prose (nucleus#1208). The branch shape lives here too, so the stash
 * forensics and a report's prose scan agree on what a queue branch looks like.
 */
export class WorkerSourceRefusal extends Error {
  constructor(readonly code: 'pr_identity' | 'worktree_branch' | 'worktree_dirty', message: string) {
    super(message);
    this.name = 'WorkerSourceRefusal';
  }
}

/** The one identity refusal text; a parked reason that carries it is a repair route. */
export const WORKER_PR_IDENTITY_REFUSAL = "PR must be open, ready, and match the task's branch and base";
export const WORKER_BRANCH_REFUSAL_PREFIX = 'Worker must remain on queue-owned branch ';
export const WORKER_DIRTY_REFUSAL_PREFIX = 'Worker must leave a clean worktree before review: ';

/** The queue-owned branch name shape, in one place; a prose scan builds its own search from it. */
export const QUEUE_BRANCH_PATTERN = 'ns-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
