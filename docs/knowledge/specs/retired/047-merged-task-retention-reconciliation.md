# 047 — Merged-task retention reconciliation at the integration base

Status: retired (2026-10-14)
Owner: Queue runtime maintainers
Created: 2026-10-05
Decision owner: Project-a planner, under Tom's blanket completion authority, 2026-10-05
Governing refs: [Spec 002](../002-durable-hook-retry-and-isolated-writes.md) (durable hook retry),
[repository-hooks contract](../../contracts/repository-hooks.md) (pre-archive retention gate)

## Problem

A done, merged task can hold its retained worktree on a refused
`task.pre_archive` gate whose pinned manifest and program predate the
consumer's repair on main. The ordinary gate pins both at the retained
worktree head, so a correction merged afterwards never reaches the refused
occurrence; the done-task archive requires the worktree at the recorded
prHead and clean, so a corrective commit inside it is refused; and the
settled refusal is reused, so automatic retries and `retry_hook` re-run
nothing new. The task stays on the Open board because any terminal task with
a non-empty `cleanupReason` keeps its worktree. There is no supported repair
route short of bypassing the gate.

## Rule

A merged done task's `task.pre_archive` may be reconciled at the current
integration base, with immutable recorded commit and digests, task identity
and a clean exact recorded-worktree proof. This is only an explicit,
supported reconciliation of a recorded archive refusal. No silent repinning
of active or unmerged tasks. No gate bypass, no edits or commits in the
retained worktree, no workspace disposal or task deletion. Archived history
and the original raw obligations are preserved.

## Change

- New operator control `retry_retention_at_integration_base` on `queue.task`,
  taking the task id, version and a required reason. It is never invoked
  automatically. Before any effect it refuses unless the task is done and
  merged with no merge intent pending, the latest `task.pre_archive`
  occurrence for the retained workspace is a settled refusal or hold, the
  retained worktree exists at exactly the recorded prHead and is clean, the
  merged commit is an ancestor of the current `refs/heads/<baseBranch>`
  commit, and the manifest there still binds the same hook id for
  `task.pre_archive`. The CLI prints an acceptance message to stderr when
  Queue accepts the request; the task JSON remains on stdout and backpressured
  responses get no acceptance message.
- The control mints one new occurrence with the manifest and repository
  program pinned at that integration base and runs it read-only in the
  retained worktree. Execution spawns the program blob pinned at the base
  from a Queue-owned ephemeral file outside the worktree — never the
  worktree file at the refused head — with the worktree as cwd. The event uses the additive `paseo.queue.event.v4`
  payload: every v1 field is kept, and `repository` names
  `target: merged_integration_base` with the retention linkage (route
  `merged_task_reconciliation`, merged commit, observed task head, manifest
  digest at the base, and the refused prior occurrence). The hook record
  carries the pinned base, manifest digest and executable digest immutably,
  plus the prior linkage. A later retry after a failed reconciliation keeps the
  original refused occurrence at the retained task head as that predecessor;
  the failed integration-base attempts remain immutable history. Missing original
  occurrence or payload refuses before new intent. Queue never parses declarations; the consumer's
  gate reads the declaration from the Git object at the pinned base.
- A settled success of that reconciliation for the same task, workspace path
  and head satisfies the retention gate, so the next done-workspace pass
  archives without re-running the stale gate. A successful reconciliation also
  clears that workspace's archive retry backoff and queues its cleanup
  immediately. A changed head, a dirty
  worktree or a different workspace re-gates normally; a refusal stays a
  hold with its evidence. Ordinary pre-archive emission and every active or
  unmerged task keep the worktree-head pin and the frozen v1 payload.
- The control stays CLI and engine only until the operator can see it in the
  UI: the northstar skill does not carry it yet.

## Acceptance oracle

- The control refuses when the task is not done, is unmerged, has merge
  intent pending, has no recorded pre-archive refusal, or when the worktree
  head moved, the worktree is dirty, the merged commit is not an ancestor of
  the base, or the manifest or hook is absent at the base.
- Success pins the base and both digests, emits exactly the v4 payload, and
  the lifecycle archive accepts the settled success without re-running the
  gate, clears that workspace's archive retry backoff and queues cleanup
  immediately; a changed head re-gates through the ordinary v1 emission. The fresh
  occurrence always runs its own pins, even when the base still equals the
  refused pin: the ordinary open-record search would otherwise resume the
  refused occurrence and orphan the fresh intent, bricking a later retry.
- An ordinary pre-archive emission and an active or unmerged task are
  unchanged: worktree-head pin, v1 payload.
