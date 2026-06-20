# 472 Completion SCM Capture Preparation Diagnostics Source

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../101-completion-scm-capture-preparation-persistence.md`

## Purpose

Feed persisted capture-preparation records into preparation diagnostics.

## Scope

- Diagnostics can summarize persisted preparation records.
- Missing state remains empty, not invented.
- Control DTO wiring is deferred unless selected next.

## Acceptance Criteria

- [x] Persisted preparation records produce diagnostics counts.
- [x] Unsupported and repair states are visible in counts.
- [x] Missing state is empty and read-only.
- [x] No SCM or forge effect executes.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_diagnostics_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
