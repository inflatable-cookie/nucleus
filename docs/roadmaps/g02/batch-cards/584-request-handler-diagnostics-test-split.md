# 584 Request Handler Diagnostics Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Split the largest request-handler diagnostics test file into focused modules
without changing behavior.

## Scope

- Keep diagnostics coverage intact.
- Move related test groups into named files under the existing test module
  structure.
- Keep shared fixtures local and small.
- Do not add new diagnostics behavior.

## Acceptance Criteria

- [ ] `request_handler/tests/diagnostics_queries.rs` is no longer the dominant
  god-file pressure point.
- [ ] Moved tests keep their existing assertions and names where practical.
- [ ] Module names make the diagnostics domain obvious.
- [ ] No production behavior changes are made.

## Validation

- `cargo test -p nucleus-server request_handler -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
