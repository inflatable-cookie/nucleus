# 430 Live Evidence Task State Handler Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../093-live-evidence-task-state-control-integration.md`

## Purpose

Compose live evidence task-state transition admission from handler state.

## Scope

- Read completion diagnostics state.
- Admit transition from task/work/completion/operator/evidence refs.
- Keep admission explicit and read/write bounded.

## Acceptance Criteria

- [x] Handler can produce admitted transition for valid refs.
- [x] Handler blocks missing or repair-required refs.
- [x] Handler preserves evidence refs.
- [x] Handler grants no provider or SCM authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_handler_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
