# 056 Work Item Runtime Linkage Projection

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../015-task-backed-agent-work-unit-proof.md`

## Purpose

Project runtime events and receipts into a task work-item timeline without
making the task timeline a raw transcript store.

## Scope

- Link work items to agent session events and runtime receipts.
- Add projection records for summarized task work progress.
- Preserve replay determinism.
- Keep raw provider payloads and terminal streams out of the projection.

## Acceptance Criteria

- [x] Work-item projection can show runtime progress from event and receipt
  refs.
- [x] Replay can rebuild the projection deterministically.
- [x] Timeline summaries remain sanitized and client-safe.
- [x] Missing runtime refs surface as repair/recovery state.

## Outcome

- Added deterministic runtime-link projection records for task work items.
- Projected session, turn, receipt, checkpoint, timeline, validation, and
  artifact refs into sanitized progress entries.
- Added linked, partial, and repair-required linkage states.
- Kept raw provider payloads and terminal streams out of projection entries.

## Validation

- [x] `cargo test -p nucleus-engine task`
- [x] `cargo test -p nucleus-server task`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if projection needs raw provider transcript storage to satisfy the
  acceptance criteria.
