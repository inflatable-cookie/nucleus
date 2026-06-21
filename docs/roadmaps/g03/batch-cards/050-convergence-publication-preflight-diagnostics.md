# 050 Convergence Publication Preflight Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../012-convergence-publication-admission.md`

## Purpose

Add stopped-by-default preflight and diagnostics for Convergence-like
publication admission.

## Acceptance Criteria

- [x] Preflight requires operator confirmation, destination readiness, and
  review-publication readiness.
- [x] Diagnostics summarize admitted, blocked, and repair-required records.
- [x] Snapshot/publish/publication-review terms remain provider-specific.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_preflight -- --nocapture`
- `cargo test -p nucleus-server convergence_publication_diagnostics -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
