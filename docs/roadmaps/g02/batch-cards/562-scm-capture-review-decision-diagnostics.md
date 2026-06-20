# 562 SCM Capture Review Decision Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../119-scm-capture-review-decision-persistence.md`

## Purpose

Summarize persisted SCM capture operator review decisions.

## Scope

- Count accepted, rejected, needs-changes, and abandoned decisions.
- Count blocked and repair-required decision attempts.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics count each decision status.
- [x] Diagnostics count blocked acceptance attempts.
- [x] Diagnostics expose no raw output.
- [x] Diagnostics grant no SCM or forge authority.

## Validation

- `cargo test -p nucleus-server scm_capture_review_decision_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
