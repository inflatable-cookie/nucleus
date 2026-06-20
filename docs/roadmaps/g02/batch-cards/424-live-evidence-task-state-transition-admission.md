# 424 Live Evidence Task State Transition Admission

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../092-live-evidence-completion-task-state-transition.md`

## Purpose

Admit explicit task-state completion transitions from validated live evidence
completion read-model refs.

## Scope

- Require completed work-item refs.
- Require operator and completion evidence refs.
- Block repair-required, skipped, duplicate, and missing completion refs.
- Reject provider, callback, interruption, recovery, SCM, and raw-material
  requests.

## Acceptance Criteria

- [x] Valid completion read-model refs admit task-state transition.
- [x] Missing or repair-required refs block transition.
- [x] Duplicate/skipped refs block transition.
- [x] Admission grants no provider or SCM authority.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_transition_admission -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
