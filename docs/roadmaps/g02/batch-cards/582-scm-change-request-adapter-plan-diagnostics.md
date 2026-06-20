# 582 SCM Change Request Adapter Plan Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../123-scm-change-request-adapter-plan-selection.md`

## Purpose

Summarize adapter-specific change-request plan selection.

## Scope

- Count Git-like, convergence-like, unsupported, and blocked plans.
- Count blockers deterministically.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics count plan kinds.
- [x] Diagnostics count unsupported adapters.
- [x] Diagnostics count blockers.
- [x] Diagnostics grant no SCM or forge authority.

## Validation

- [x] `cargo test -p nucleus-server scm_change_request_adapter_plan_diagnostics -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
