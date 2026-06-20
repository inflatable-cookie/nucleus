# 572 SCM Change Request Prep Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../121-scm-capture-change-request-preparation-admission.md`

## Purpose

Summarize change-request preparation admission readiness.

## Scope

- Count admitted, blocked, and repair-required candidates.
- Count decision-state blockers.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics count admitted candidates.
- [x] Diagnostics count blocked candidates.
- [x] Diagnostics count blockers deterministically.
- [x] Diagnostics grant no SCM or forge authority.

## Validation

- `cargo test -p nucleus-server scm_change_request_prep_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
