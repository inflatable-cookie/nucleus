# Owner completion of an accepted report without a PR

Status: retired (2026-10-14); replaced by the [Spec 050](../050-owner-task-controls.md) `complete` verb

## Purpose

A project owner may finish one delivered Queue task whose immutable original
scope is explicitly report-only and requires no repository change or PR. This
is a task disposition for an accepted report. It does not create a worker
completion, review verdict, validation result, PR, merge or closeout receipt.

## Control

The versioned `queue.task` action is `complete_report_only`. Its supported
payload is:

```json
{
  "taskId": "<task id>",
  "version": 12,
  "action": "complete_report_only",
  "ownerAgentId": "<current PASEO_AGENT_ID thread>",
  "reportArtifact": {
    "key": "web-code-health",
    "version": 3,
    "digest": "sha256:<64 lowercase hex characters>"
  },
  "reason": "I accept this report with its stated limitations."
}
```

The CLI caller omits `ownerAgentId`; Queue CLI adds it from `PASEO_AGENT_ID`. A
caller-supplied value must match that thread. Queue then matches it to the
current active project owner and freshly observes that owner identity. The
accepted task version is stored with the exact artifact, owner, reason and
acceptance time.

## Required proof

Queue refuses unless all of these remain true through the final transaction:

- The task is blocked or errored, dispatched, retained, and has its accepted
  blocked worker callback and immutable receipt. Every saved run has a matching
  callback receipt; unknown creation, missing delivery, reserved or uncertain
  effects refuse.
- Every immutable Queue brief version hashes to its recorded digest and
  explicitly describes a report outcome, excludes code changes under `Not in
  scope`, and says `Report only` under `Validation`. The initial handoff text
  matches the first pinned version.
- The artifact exists at the requested key, version and digest, hashes to its
  stored content, is the latest version, belongs to a lane attached to this
  task, and that lane includes the task repository.
- The active project owner is the caller. Project, task, artifact, runs,
  callbacks, hooks, notices, operations, dependencies, outcome and pause state
  are snapshotted and compared after every await and inside the final
  transaction.
- No adoption, recorded/open PR, PR head, unmerged commit, merge identity,
  unresolved review delivery, code validation result, blocking hook, uncertain
  notice, pending task operation, unresolved prerequisite, active recovery,
  disposition, pause or hold owns the task.
  The exact matching unanswered report-disposition escalation is answerable by
  this owner acceptance only when its released recovery callback, receipt,
  worker incident and lineage all match and no recovery or current run remains
  active; Queue resolves those records and supersedes pending attention notices
  atomically. Other escalations refuse.
- The task branch is exactly `ns-<task id>`. Both the task worktree and planning
  checkout are clean, share the same Git root and repository origin, and prove
  `HEAD == planningCommit == planningBase == current base branch HEAD`. The
  action fetches, switches and publishes nothing.
- The owner identity is current. Every task participant is observed twice,
  250 ms apart, with the same recorded agent and workspace identity, inactive,
  permission-free and in `idle`, `error` or `closed`. A stopped unreleased lease
  also needs its accepted callback receipt; only that lease's callback
  credential is revoked when it is retired. No replacement or continuation is
  launched.

Any changed state or identity refuses without completing the task. The same
accepted artifact, owner, reason and original task version returns the settled
result without adding another completion or notice. A changed request refuses.

## Durable result

The existing terminal `done` path writes the ordinary permanent outcome,
completion cohort and notification, then leaves finished hooks, dependencies,
retention and archive handling to their ordinary owners. The task keeps its
original worker completion, callback receipts, brief history, reports,
caveats, review/checkpoint history, lanes, dependencies, holds and Queue
settings. A matching report-disposition escalation remains in history with
resolved status. Only proven-idle stopped leases can have their release state
and credential updated.

`task.reportAcceptance` and `outcome.reportAcceptance` hold the structured local
record. The outcome remains `done`, with PR, merge, review, validation and
closeout empty unless an existing preserved fact says otherwise. The
completion notice names the exact accepted lane document and owner. No field
claims code passed or merged.

Contract 008 has no structured report-acceptance field. Portable export omits
that local field and retains the owner, exact artifact key/version/digest,
reason and no-PR statement in the existing outcome `reason`. Import does not
claim that the structured acceptance was transported. It does not add an enum
or synthesize merge data.

## Live handover: Consumer-b #533

The implementation task does not mutate #533, start participants or apply the
control. After the reviewed merge, the Queue owner reloads only the Queue plugin
and rechecks the live task, current project owner, lane document and exact
digest. The task must remain blocked without a PR; the owner must remain
`3d4ecdc3-470d-4dbc-a501-14dc579e9a50`; and `web-code-health` v3 must remain
`sha256:8e5b995564a2c454429ee9935349d5c3772e6439318bad3ae361bff22064a7e0`.
The control itself performs the repeated participant observations and refuses
if any identity, permission, Git or callback proof is uncertain. Original
timing and partial-Knip caveats stay intact.

## Focused oracle

Tests cover exact owner acceptance and no-PR outcome, idempotency, Contract 008
export behavior, owner/scope/artifact refusals, absent callback, open PR, dirty,
wrong-branch, unmerged and wrong-root Git identity, active/permission/unknown
participants, a post-await owner race, and identity-bound retirement of a
completed stopped lease. They also prove a matching released report-disposition
escalation is resolved without deleting its callback, incident or recovery
history, and draft PRs refuse. CLI tests prove the owner identity comes only
from the calling `PASEO_AGENT_ID` value.

## Report-only workspace retirement

Owner acceptance also queues the ordinary workspace title and archive projections.
An accepted report needs no merge identity: its retained workspace is archived
against the unchanged planning base after the normal finished, retention,
writer-exclusion and ownership gates. An unpublished empty task branch is eligible
only when the exact clean task and planning checkout still match the pushed base.
Dirty, advanced, switched, active or uncertain workspaces remain preserved.
Existing accepted reports are picked up by the normal terminal cleanup sweep;
no worker continuation or invented PR, merge or verdict is required.
