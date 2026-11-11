# 003 - Post-dispatch task disposition

Status: implemented
Owner: operator and Chatterbox
Created: 2026-09-13
Governing refs: `docs/knowledge/contracts/working-rules.md`,
`docs/knowledge/contracts/orchestration.md`
Execution: g01.012 ready under Tom's explicit authorization

## Problem

Nucleus cancellation ends at the dispatch boundary. Once a task owns a workspace
or agent, stopping that agent causes normal recovery to restart the work. An
operator cannot safely withdraw a duplicate or obsolete task without manually
coordinating callbacks, recovery leases, work inspection, and workspace
cleanup.

The acceptance incident is the duplicate submission of scoped PR revision
instructions. Task `ed66ddf0-925d-4458-9940-a23a7ea018a7` already held the
substantive implementation and later merged PR #12. A timed-out submit led to
duplicate task `e8b299f4-533b-4da0-9d11-2e118822d168`, whose worker had made no
edits. Stopping the duplicate worker triggered recovery and a concurrent
coordinator. Removal became available only after an operator-authored blocked
callback and recovery release. One disposition request should have stopped and
archived the empty duplicate without restarting it, while preserving the
original task and its work.

## Outcome

One versioned operator action cancels or supersedes a task after dispatch.
Nucleus first records a durable disposition fence that disables ordinary task
advancement, recovery, relaunch, review, merge, closeout, and notification.
It then drains owned runs, preserves work evidence, and archives only resources
proved safe. Restart resumes the disposition workflow from its recorded step.

Cancellation records why the task ended unfinished. Supersession additionally
records the retained replacement task and the disposition of every unique
workspace, commit, branch, and PR. Neither outcome satisfies dependants.

## Bulk disposition

A bulk disposition is one durable Nucleus operation over an explicit versioned
task list. A stable operator-supplied operation ID makes retries idempotent.
Nucleus validates every target and records every cancellation or supersession
fence in one SQLite transaction before returning. If any target is stale or
invalid, no target is fenced.

After the atomic fence, Nucleus drains preservation, agent and workspace effects
one target at a time. Per-target status, attempts, task version and bounded
error text remain durable. Plugin startup resumes pending or running
operations. A retry resets only attention items; completed items never repeat.
A batch may contain at most 256 targets, and Nucleus retains a bounded index of
the latest 100 operations.

The native RPCs are `queue.bulk-disposition`,
`queue.bulk-disposition-detail` and `queue.bulk-disposition-retry`. The Nucleus
MCP bridge exposes the same interaction. Selection stays outside the mutation
contract: callers inspect tasks, provide exact IDs and versions, and state one
shared disposition. Nucleus does not select tasks by title, roadmap or repository
document structure.

## Control contract

Expose one shared control through the native plugin RPC/UI, a standalone Nucleus
helper, and the authenticated Nucleus MCP bridge:

```json
{
  "taskId": "queue-task-id",
  "version": 41,
  "action": "cancel" | "supersede",
  "reason": "operator reason",
  "replacementTaskId": "required-for-supersede-or-absent",
  "workDisposition": "preserve" | "archive_if_empty" | "retained_by_replacement"
}
```

Rules:

- `reason` is required, retained verbatim within the existing bounded text
  limit, and shown in task detail and history.
- `replacementTaskId` is required only for supersession. It must name a
  different, existing, non-removed Nucleus task in the same canonical repository.
  Nucleus records immutable task identity, branch, workspace, and accepted work
  evidence; a title match is never sufficient.
- `archive_if_empty` is the safe default. Nucleus may archive the task workspace
  only after proving its queue branch, HEAD, index, tracked and untracked state,
  remote head, and PR state contain no unique work relative to the task's
  planning base.
  Work that is safely on origin is not unique (Tom, 2026-09-27: cancelled tasks
  left workspaces he had to check and archive by hand). A clean worktree on the
  queue branch whose every commit is on the remote queue branch may be archived
  even with commits beyond the base or a PR; the branch and PR stay on GitHub.
  When the queue branch is absent on origin (never pushed, or deleted after a
  merge), HEAD contained in any live origin branch, such as the merged base,
  is published work too (round 4, 2026-10-19). A local tracking ref counts only
  while it equals that branch's live head on origin. The task's own open PR is closed with a comment giving the cancel reason
  (Tom, 2026-09-27: a cancelled task's PR was left open). The branch is kept. Unpushed or
  dirty work, another task's workspace, a wrong branch or repository, and a
  missing directory still preserve it. A PR the forge proves foreign — observed,
  with a head branch or repository that does not match the task — is not the
  task's own PR (nucleus#1000): a PR known only from a foreign stored result, such
  as another task's report recorded as this task's completion, is left untouched;
  the close-PR step records the definite "no PR of its own to close" finding and
  the disposition continues. Only an unobservable forge holds attention.
  An archive that Paseo acknowledges late
  under backpressure is reconciled by observation, not left for an operator.
- `preserve` leaves the task workspace, branch, and commits intact after agents
  and leases are safely drained. On cancellation, Nucleus still comments with the
  reason and closes the task's recorded open PR; supersession leaves the PR to
  replacement rules. Terminal detail links the preserved workspace evidence
  and explains why it remains.
- `retained_by_replacement` is valid only for supersession and requires Nucleus
  to prove that the replacement retains every unique task commit and relevant
  PR head. Failure falls closed with the original evidence preserved.
- A repeated byte-identical request at the same or returned version reports
  the stored disposition. A disposition parked in `needs_attention` also takes
  a fresh same-kind request as an explicit owner re-run of the parked step
  (nucleus#1000): cancel re-runs a cancellation, and a supersession re-run must
  name the same retained replacement. The recorded fence — kind, reason,
  replacement link and work disposition — is never rewritten; the fresh reason
  is recorded on the `disposition_retry_requested` event and the driver
  reconciles the parked step again. A conflicting request or stale
  pre-disposition version fails without changing state.
- The separate `queue.task` action `withdraw_cancel` takes the current task
  version and a required reason. It withdraws a cancel while the disposition is
  still in `intent` or `draining` with every recorded effect a pending
  `stop_thread` request, and while the fence is parked in `needs_attention`
  (nucleus#1000): the uncertain step held the fence, and its landed effects are
  reversible hygiene (thread stops, run releases, thread archives) or acted only
  on the task's own PR, so the withdrawal leaves no foreign side effect behind.
  Nucleus clears the
  fence, leaves the task in its current phase, and records the actor and reason
  in task history. If drain already interrupted that worker, Nucleus continues
  the same thread (`ns-withdraw-${taskId}-${version}`) so it is not left idle
  with the stop message; a continue failure is recorded and does not roll back
  the withdrawal. A stale version, supersession, or any other landed
  disposition effect outside a parked `needs_attention` fence refuses
  withdrawal. Interrupt itself is not a landed effect.
- Each owned thread has at most one pending `stop_thread` intent. Later drain
  passes reuse that intent; a new one is recorded only after the prior intent
  has a result and a retry is needed.
- The control requires trusted plugin authority or a bound Nucleus MCP session
  plus explicit operator authority in the caller's instruction. A worker,
  reviewer, or recovery callback cannot cancel its own task.
- Existing pre-dispatch cancellation routes through the same durable model.
  Removal stays a separate history-retention action and cannot substitute for
  disposition.

## Durable lifecycle

The task stores a disposition object before any remote effect:

```text
kind: cancel | supersede
status: intent | draining | preserving | archiving | complete | needs_attention
requestedAt, requestedBy, reason, replacement identity, work disposition
run/agent/workspace/branch/PR evidence and per-effect intent/result
refSnapshot (null until the first successful origin listing; empty means listed
and none matched), postDispositionRefs (queue-branch or tag refs that appeared
or moved on origin after that snapshot), proofPolicies (attributed owner
transitions of the workspace proof policy; the original workDisposition stays
as requested)
```

The task enters `cancelling` while this object is incomplete. The initial
transaction increments the task version and is the hard orchestration fence.
Every engine entry point checks the fence before creating or resuming workers,
reviewers, verifiers, coordinators, closeout agents, hooks, notices, merges, or
integration work. Late authenticated callbacks remain immutable evidence but
cannot advance the task.

Nucleus then:

1. snapshots all task-owned runs, agents, workspaces, branch heads, accepted
   callbacks, review state, PRs, outstanding side-effect intents, and origin
   heads and tags (`git ls-remote --heads --tags origin`). A listing failure
   leaves `refSnapshot` null and retries on the next pass; it never stores an
   empty snapshot as success;
2. interrupts each active owned turn immediately through Paseo's
   `sendAgentMessage` with `activeTurnBehavior: "interrupt"` (the same channel
   as stall continuation). Nucleus records the `stop_thread` intent first, then
   interrupts once per agent with message id `ns-stop-${taskId}-${agentId}`.
   Success is a `disposition_turn_interrupted` event, not a landed effect.
   Interrupt failure records that `stop_thread` uncertain and holds attention.
   Drain still waits until the turn is proved stopped. Each later pass lists
   origin again and records queue-branch or tag refs that appeared or moved
   after the snapshot on `postDispositionRefs` and in task detail. If interrupt
   is unavailable, Nucleus waits as before;
3. releases a run lease only after its turn is proved stopped, closed, or
   superseded; generation fencing rejects late authority;
4. archives task-owned agents only after their final state and delivery
   evidence are durable;
5. for cancellation, checks the recorded PR number and head branch, comments
   with the reason and closes an open task PR; an already closed or merged PR
   is untouched. Supersession leaves the PR to replacement rules. Nucleus keeps
   the branch and reconciles an uncertain comment or close from GitHub state;
6. inspects Git and GitHub evidence and applies the requested work disposition;
7. discovers task-local Cargo package/workspace `target` directories and
   `node_modules` roots, then removes them and archives a Nucleus-owned
   workspace only after exclusive ownership, a clean queue branch, a published
   branch head, idle workspace threads, and no live task run are proved;
   Cargo metadata runs from each package directory and supplies that invocation's
   `target_directory`, applying its Cargo config and environment overrides.
   Resolved target paths are deduplicated, and each package and workspace's
   conventional `target` directory is also checked for stale output. Before
   removal, Nucleus rejects paths that traverse symlink components and checks
   tracked content against the canonical path. A manifest Cargo cannot resolve
   in place (for example a staged proof crate that is deliberately not a
   workspace member) is recorded as a note: its conventional `target` is still
   cleaned and it does not block archival (Longhorn, 2026-09-30). If metadata
   selects a target outside the task worktree, or a root cannot be proved safe,
   cleanup stays incomplete and records the full path, package/workspace roots, config
   path, and reason on the task;
   adopted, shared, missing, dirty, unpublished, divergent, or uncertain
   workspaces are preserved with the reason on the task. Build output cleanup
   has durable intent and an observed result. After restart, Nucleus observes the
   same output roots and resumes an incomplete idempotent removal before archive.
   Cleanup refuses each discovered output root if Git reports a tracked path
   at or below it, including a tracked symlink at the root itself, even when
   Git otherwise considers the worktree clean. A skipped root is shown on the
   task with its full path and reason, and prevents Nucleus from claiming cleanup
   is complete. For a cancelled archive-if-empty task, the operator can use
   `retry_build_output_cleanup` after addressing its blocker; Nucleus repeats the
   clean-worktree, published-head, ownership and idle-thread proofs before
   another removal or archive attempt. Success clears only the build-output
   cleanup reason. Task-local Cargo targets and `node_modules` are removed
   only after these proofs; the per-user Cargo package cache is outside the
   workspace and is never removed by task cleanup. Symlinked output roots are
   preserved and reported. Sibling shared build caches are deferred to a
   follow-up; Cargo downloads continue to use the per-user `CARGO_HOME` cache.
   A delayed archive is observed, then retried once only if the workspace is
   still present. If it remains present after that retry, Nucleus records the
   evidence and preserves it; only an unknown archive outcome holds attention;
   and
8. enters terminal `cancelled` with disposition kind `cancel` or `supersede`,
   durable evidence, operator reason, and completion time.

The terminal transition also resolves the attention episode the disposition
answered. It clears `resolution.attention`, supersedes pending notices and
unsettled delivery intents, and records the resolution without erasing an
escalated incident or recovery retained as evidence. Resolution-run
observation, notice delivery, and recovery routing reject a completed
disposition, so the terminal task cannot derive fresh work later.

An uncertain stop, archive, Git, PR, ownership, or prior side effect records
`needs_attention` inside the disposition and retains `cancelling`. Retry
reconciles the same persisted effect; it never launches a general recovery
coordinator or a replacement task worker. Engine restart scans incomplete
dispositions before normal task resolution. A parked fence always has the
owner's two exits (nucleus#1000): `withdraw_cancel`, or a same-kind request
that re-runs the parked step — `task.next` offers whichever applies, and a
cancel whose stored completion names a foreign PR settles under the re-run
without touching that PR.

### Recovering a workspace step after its evidence changed

A disposition that stopped at its workspace proof or archive is the owner's to
resume through the existing `retry_effect` (`disposition_workspace.<workspaceId>`,
Spec 050). The store derives the effect identity: only the last recorded
`workspace_proof` or `archive_workspace` occurrence for the task's own workspace,
while it is still uncertain, can reopen that step. The original request — kind,
replacement link, reason, `workDisposition` and every recorded effect intent and
result — is history and is never rewritten.

Re-running the recorded policy is the ordinary recovery: a returned replacement
workspace, repaired archive custody or a resolved unknown archive is proved
again immediately before any effect. A resumed step never replays a settled
effect: a thread whose `archive_thread` already has a definite result, a
resolved PR close, the origin snapshot and an already-emitted cancellation hook
are read, not repeated, and an unknown archive is observed before any archive
request.

When the recorded `retained_by_replacement` proof cannot be produced at all —
the recorded replacement workspace was retired after its own merge — the owner
may explicitly select the existing safe `archive_if_empty` policy on the same
retry. It is one attributed transition appended to `disposition.proofPolicies`
(policy, previous policy, time, owner identity, authority kind, authorization
note and reason), recorded before the proof runs; it invents no retention and
claims nothing about the replacement. The selected proof is the ordinary
`archive_if_empty` rule, including the clean queue branch, every local commit
published on the canonical origin, exactly one open or closed recorded PR and
no other task's workspace, so dirty, local-only, foreign-remote and unknown
work stay preserved. No discard, force archive or policy fallback is implied,
and a different policy on the already-reopened step refuses rather than
rewriting the recorded one.

A lost reply replays its own durable identity: the recorded transition is kept
once, a repeated reopen under the same policy writes nothing more, and a
recorded `task_control` operation whose disposition already completed is
answered by that settled task instead of re-running the step. An interrupted
reopen leaves the fence in `preserving` with every effect intact, so the ordinary
restart pass resumes the same step without dispatching a worker, reviewer or
coordinator.

## Dependencies, hooks, and visibility

- Only `done` satisfies a prerequisite. `cancelling` and terminal `cancelled`
  keep dependants waiting with a reason naming the unfinished prerequisite.
- Supersession does not silently rewrite dependant edges. The existing
  versioned dependency control remains the explicit way to select the
  replacement prerequisite.
- `task.cancelled` fires once after work preservation and before the terminal
  transition. Its durable payload identifies cancel versus supersede and the
  replacement task when present. Required or uncertain hook effects hold the
  same disposition; they cannot remove the orchestration fence.
- If unrelated integration work advances the repository before a blocked
  `integration_write` cancellation occurrence reaches commit intent, Nucleus
  proves the old occurrence unpublished, retains it as failed audit evidence,
  and mints a fresh occurrence at the clean synchronized base. Commit, push, or
  ambiguous publication evidence still fails closed.
- One bounded admission exception prevents an impossible disposal loop. When
  Nucleus proves that no workspace, agent, run, completion, or PR ever existed,
  and `task.cancelled` repeats the exact terminal refusal already recorded by a
  required `task.pre_dispatch` occurrence, the operator disposition fence may
  treat that repeated refusal as settled. Both hook records remain durable
  evidence. A different refusal, any uncertain effect, or any task-owned work
  retains the normal required-hook hold.
- Board and detail views show Cancelling, Cancelled, or Superseded; operator
  reason; replacement task; progress or attention; preserved work; PR; run and
  agent outcomes; whether a workspace was archived or retained; and any
  queue-branch or tag refs pushed after the disposition fence.
- The task event log records request, every remote-effect intent/result,
  refusal, retry, evidence decision, and terminal transition.

## Refusal boundaries

Reject before the initial intent when the version is stale, the task is already
done, the replacement is invalid, the repository identity differs, or the
request lacks authority. After intent, preserve the fence and stop in visible
attention when an effect is uncertain. Never infer empty work from an idle
agent, a clean index alone, a missing local branch, or absence of a task PR.
Never archive an adopted or shared workspace.

## Acceptance

Focused tests cover cancellation and supersession from working, reviewing,
verifying, syncing, closing, blocked, and active recovery; queued compatibility;
concurrent recovery fencing; late callbacks; active and uncertain turn
interrupt; a later origin tag after the snapshot; withdraw after interrupt
continues the worker; restart at every persisted effect boundary; empty, dirty, committed, pushed,
PR-backed, adopted, shared, and missing workspaces; dependency blocking;
required cancellation hooks; stale and repeated requests; invalid replacement;
and UI, RPC, helper, and MCP schema parity.

The incident fixture creates two tasks for the same intended feature. The
original contains unique dirty implementation. The duplicate has a dispatched
worker, an active recovery opportunity, a clean queue-owned workspace at its
planning base, and no PR. One supersede request naming the original must fence
all relaunch, drain the duplicate's worker and any already-started coordinator,
archive its empty workspace, preserve the original workspace byte for byte,
leave dependants unsatisfied until explicitly rewired, and finish idempotently
after restart.

## Separate submission finding

The timed-out submit was made worse by a later dry-run returning `task: null`
even though the first submission had landed. Submission reconciliation is a
separate API/idempotency surface from task disposition and is not bundled into
g01.012. The finding remains open in
`docs/triage/20260913-120000-submission-timeout-reconciliation.md`. The future
fix must give callers a read-only way to distinguish “not submitted” from
“already accepted” after timeout without creating or dispatching another task.
