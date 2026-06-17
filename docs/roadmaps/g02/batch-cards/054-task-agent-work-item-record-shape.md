# 054 Task Agent Work Item Record Shape

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../015-task-backed-agent-work-unit-proof.md`

## Purpose

Define the first task-owned work item record that can link a task to an agent
session, runtime receipts, timeline events, and review state.

## Scope

- Add compile-only Rust records for task agent work items.
- Keep task acceptance separate from provider completion.
- Link by ids and refs; do not copy raw transcript streams.
- Keep provider-specific Codex details behind adapter/session refs.

## Acceptance Criteria

- [x] A task can own one or more work items.
- [x] A work item can reference an agent session, turn, receipts, and
  checkpoints.
- [x] Review/acceptance state is represented separately from runtime status.
- [x] Record shape stays portable across Codex and future adapters.

## Outcome

- Added engine-owned task work item records.
- Linked work items to agent sessions, turns, runtime receipts, checkpoints,
  timeline entries, validation refs, and artifact refs.
- Kept runtime status separate from operator review status.
- Kept assignment portable across Codex and future adapter instances.

## Validation

- [x] `cargo test -p nucleus-engine task`
- [x] `cargo test -p nucleus-server task`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if the work-item model needs new task contract decisions before a stable
  record can be named.
