# 037 Task Command Desktop Refresh Loop

Status: completed
Owner: Tom
Updated: 2026-07-07
Milestone: `../008-task-command-outcome-coherence.md`

## Purpose

Refresh task workflow proof state after a task-only command without stale
selected-task props.

## Work

- [x] Reload task workflow drilldown after command receipt.
- [x] Reload selected-task action readiness and operator gate after command
  receipt.
- [x] Re-query command admission only from current server state.
- [x] Keep block reason reset scoped to successful block submission.

## Acceptance Criteria

- [x] Proof panel state reflects server-owned state after a command.
- [x] Stale selected-task revision does not silently drive a second command.
- [x] Failed or rejected commands leave the prior proof state visible.

## Result

- Added a post-command refresh wait state keyed to the submitted task revision.
- Disabled task-command proof controls until the shell receives a refreshed
  server task record.
- Scoped block reason reset to successful block command receipts.
- Kept failed and rejected command paths on the existing proof state.
