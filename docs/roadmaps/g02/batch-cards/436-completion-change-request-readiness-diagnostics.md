# 436 Completion Change Request Readiness Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../094-completion-to-scm-change-request-readiness.md`

## Purpose

Expose read-only diagnostics for completion-to-change-request readiness.

## Scope

- Count candidates, ready records, unsupported states, and blockers.
- Keep diagnostics sanitized.
- Keep change-request creation out of scope.

## Acceptance Criteria

- [x] Diagnostics summarize readiness state.
- [x] Unsupported and blocked states are visible.
- [x] No raw provider material appears.
- [x] No SCM/forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_change_request_readiness_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
