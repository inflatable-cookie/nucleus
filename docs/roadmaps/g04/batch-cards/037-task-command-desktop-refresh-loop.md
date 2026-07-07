# 037 Task Command Desktop Refresh Loop

Status: planned
Owner: Tom
Updated: 2026-07-07
Milestone: `../008-task-command-outcome-coherence.md`

## Purpose

Refresh task workflow proof state after a task-only command without stale
selected-task props.

## Work

- [ ] Reload task workflow drilldown after command receipt.
- [ ] Reload selected-task action readiness and operator gate after command
  receipt.
- [ ] Re-query command admission only from current server state.
- [ ] Keep block reason reset scoped to successful block submission.

## Acceptance Criteria

- [ ] Proof panel state reflects server-owned state after a command.
- [ ] Stale selected-task revision does not silently drive a second command.
- [ ] Failed or rejected commands leave the prior proof state visible.
