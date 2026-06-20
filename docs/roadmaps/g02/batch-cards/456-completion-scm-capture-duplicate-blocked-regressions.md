# 456 Completion SCM Capture Duplicate Blocked Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../098-completion-scm-capture-admission-persistence.md`

## Purpose

Prove duplicate and blocked capture admissions stay deterministic and visible.

## Scope

- Duplicate admission ids.
- Blocked readiness refs.
- Effect-request blockers.
- Missing evidence refs.

## Acceptance Criteria

- [x] Duplicate persistence is deterministic.
- [x] Blocked admissions persist as evidence.
- [x] Effect-request blockers remain visible.
- [x] No external authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_duplicate_blocked -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
