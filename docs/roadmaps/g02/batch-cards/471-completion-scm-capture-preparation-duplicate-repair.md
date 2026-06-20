# 471 Completion SCM Capture Preparation Duplicate Repair

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../101-completion-scm-capture-preparation-persistence.md`

## Purpose

Prove duplicate, unsupported, and repair-required preparation records remain
deterministic and visible.

## Scope

- Duplicate preparation ids.
- Unsupported adapter plans.
- Repair-required adapter plans.
- Missing evidence refs.

## Acceptance Criteria

- [x] Duplicate persistence is deterministic.
- [x] Unsupported plans persist as evidence.
- [x] Repair-required plans persist as evidence.
- [x] No external authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_duplicate_repair -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
