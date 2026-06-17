# 053 Codex Recovery And Runtime Validation

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../014-codex-live-runtime-supervision.md`

## Purpose

Close the first Codex live-runtime supervision lane with recovery and validation
before task-backed work starts.

## Scope

- Validate restart, resume, unsupported event, interruption, and failure
  receipts.
- Record limitations and follow-on gates.
- Decide whether `015-task-backed-agent-work-unit-proof.md` can become active.
- Do not add broad provider support.

## Acceptance Criteria

- [x] Codex runtime failure and recovery states are explicit.
- [x] Runtime receipts and timeline identity survive restart/recovery fixtures.
- [x] The next task-backed workflow lane has a clear gate.

## Outcome

- Added Codex runtime validation evidence and closeout report records.
- Added recovery-fallback receipt projection for explicit resume/restart
  fallout.
- Required recovery, unsupported-event, interruption, failure, and wait-state
  evidence before the task-backed work lane is considered ready.
- Promoted `015-task-backed-agent-work-unit-proof.md` as the next active lane
  with its own batch-card runway.

## Validation

- [x] `cargo test -p nucleus-agent-protocol codex`
- [x] `cargo test -p nucleus-server codex`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if Codex live behavior cannot be validated without operator credentials
  or external provider state.
