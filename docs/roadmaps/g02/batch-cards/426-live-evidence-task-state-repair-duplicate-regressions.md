# 426 Live Evidence Task State Repair Duplicate Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../092-live-evidence-completion-task-state-transition.md`

## Purpose

Prove repair-required, duplicate, skipped, and missing completion states do not
mutate task state.

## Scope

- Exercise completion read-model repair refs.
- Exercise skipped/duplicate completion refs.
- Exercise missing completion refs.

## Acceptance Criteria

- [x] Repair-required refs block transition.
- [x] Duplicate/skipped refs block transition.
- [x] Missing refs block transition.
- [x] Blocked states remain inspectable.

## Validation

- `cargo test -p nucleus-server live_evidence_task_state_repair_duplicate -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
