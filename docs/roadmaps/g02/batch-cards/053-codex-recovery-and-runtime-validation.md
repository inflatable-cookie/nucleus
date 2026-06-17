# 053 Codex Recovery And Runtime Validation

Status: planned
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

- Codex runtime failure and recovery states are explicit.
- Runtime receipts and timeline identity survive restart/recovery fixtures.
- The next task-backed workflow lane has a clear gate.

## Validation

- `cargo test -p nucleus-agent-protocol codex`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if Codex live behavior cannot be validated without operator credentials
  or external provider state.
