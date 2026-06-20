# 427 Live Evidence Task State Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../092-live-evidence-completion-task-state-transition.md`

## Purpose

Prove task-state completion transition does not grant provider, callback,
interruption, recovery, SCM, or raw-material authority.

## Scope

- Exercise admission and history projection.
- Keep SCM/share/change-request promotion separate.
- Keep provider execution separate.

## Acceptance Criteria

- [x] Transition cannot start provider writes.
- [x] Transition cannot answer callbacks or resume/interrupt providers.
- [x] Transition cannot start SCM capture/share/change-request work.
- [x] Raw material remains blocked.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
