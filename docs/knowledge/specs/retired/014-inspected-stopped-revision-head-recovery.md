# 014 — Inspected stopped-revision head recovery

Status: retired (2026-10-14)
Owner: Queue runtime and protocol maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/specs/012-durable-asynchronous-operations.md`

## Problem

A revision worker can push a valid update to the queue-owned branch and then
lose its callback. Stopped-revision recovery currently compares the live PR
head only with the stale task and stopped-run heads. It correctly refuses a
blind retry, but offers no typed way to record that the operator inspected the
new head. The retained task then cannot continue without an unsupported state
edit or replacement lane.

## Control contract

Add an optional `inspectedPrHead` to `recover_stopped_revision` and
`replace_stopped_revision`. It is a full lowercase Git commit ID and is invalid
for every other task control.

Without it, retain the existing exact stored-head check. With it, require all
of these facts immediately before the recovery transaction:

- the recorded PR is open, unmerged, non-draft and targets the recorded base;
- the PR head branch is the immutable queue-owned task branch;
- PR head, remote branch head and clean retained workspace HEAD all equal the
  supplied commit;
- repository, task, worker, workspace, branch, PR and stopped-run identities
  have not changed since the observation began;
- no merge intent, accepted later callback, active turn, permissions prompt or
  other live delivery exists.

Queue then preserves the stopped run at its original head, records the
reconciled task PR head as a durable event, supersedes only that stopped run and
issues one fresh authenticated revision run from the inspected head. The new
callback and independent review are mandatory. Inspection never imports a
review verdict, declares work complete or bypasses semantic revision limits.

## Interaction coverage

The field belongs to the shared task-control schema and the single Queue
operation input. Native UI, CLI and Queue MCP expose the same field and
operation status. The generated compatibility key includes it through the
complete normalized input digest delivered by g01.029. Explicit caller keys
remain immutable.

## Failure behavior

Any mismatch fails before mutation and returns the observed bounded identity
facts. A corrected head uses a distinct generated operation identity. Unknown
Git delivery, dirty or divergent workspace state, a different PR/base/branch,
ambiguous remote head or changed task version remains needs-attention. Queue
does not reset, rebase, merge, clean or discard the worktree.

## Acceptance oracle

- A blind recovery after an unauthenticated pushed head change still refuses.
- Supplying the exact inspected head recovers the same task, worker, workspace,
  branch and PR and creates one authenticated continuation.
- A wrong, shortened, stale, local-only or PR-only head fails with no mutation.
- Concurrent callback, worker activity, task version change or PR mutation
  loses the race safely.
- Replacement-worker recovery applies the same proof before changing only the
  retained worker identity.
- UI, CLI and MCP contract fixtures accept and forward the field; unrelated
  controls reject it.
- Restart and repeated identical operation input create no duplicate run.

## Exclusions

No generic PR adoption, arbitrary branch repair, automatic trust of a changed
head, direct database edit, merge-conflict resolution, review import or task
replacement belongs to this change.
