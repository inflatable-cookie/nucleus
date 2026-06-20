# 432 Live Evidence Task State Control Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../093-live-evidence-task-state-control-integration.md`

## Purpose

Prove task-state transition control integration cannot start provider, SCM,
callback, interruption, recovery, or raw-material effects.

## Scope

- Exercise vocabulary, handler admission, and history response.
- Keep actual provider/SCM execution out of scope.

## Acceptance Criteria

- [x] Control integration cannot start provider writes.
- [x] Control integration cannot start SCM capture/share/change-request work.
- [x] Control integration cannot answer callbacks or resume/interrupt providers.
- [x] Raw material remains blocked.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_control_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
