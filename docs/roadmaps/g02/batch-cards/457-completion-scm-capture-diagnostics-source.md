# 457 Completion SCM Capture Diagnostics Source

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../098-completion-scm-capture-admission-persistence.md`

## Purpose

Feed persisted capture admissions into capture-admission diagnostics.

## Scope

- Diagnostics can summarize persisted admissions.
- Missing state remains empty, not invented.
- DTO/control wiring is deferred unless needed by the next lane.

## Acceptance Criteria

- [x] Persisted admissions produce diagnostics counts.
- [x] Blockers are visible in counts.
- [x] Missing state is empty and read-only.
- [x] No SCM or forge effect executes.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_diagnostics_source -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
