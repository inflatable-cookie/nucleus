# 117 SCM Diagnostics Source Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../027-diagnostics-read-model-source-integration.md`

## Purpose

Source SCM diagnostics from available session and work-item linkage records.

## Scope

- Read available SCM session, admission, and work-item link records.
- Return explicit empty or unsupported state when absent.
- Preserve provider-neutral vocabulary.

## Acceptance Criteria

- SCM diagnostics use available source records.
- Missing session evidence surfaces as repair or empty state.
- Query execution does not mutate working copies.

## Validation

- `cargo test -p nucleus-server scm`
- `cargo test -p nucleus-scm-forge`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source integration requires SCM command execution.
