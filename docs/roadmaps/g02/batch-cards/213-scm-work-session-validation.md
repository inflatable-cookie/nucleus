# 213 SCM Work Session Validation

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../047-scm-work-sessions-module-split.md`

## Purpose

Validate the SCM work-session module split.

## Scope

- Run scoped SCM tests.
- Check god-file report for `work_sessions.rs`.
- Advance to diagnostics test split.

## Acceptance Criteria

- `work_sessions.rs` is below the error threshold.
- Workspace check passes.

## Validation

- `cargo test -p nucleus-scm-forge work_session`
- `cargo check --workspace`
- `effigy doctor`
- `git diff --check`

## Stop Conditions

- Stop if the split requires behavior changes.

## Result

`cargo test -p nucleus-scm-forge work_session` and `cargo check --workspace`
pass. `effigy doctor` god-file errors dropped from five to four.
