# 551 SCM Capture Review Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../117-scm-capture-operator-review-readiness.md`

## Purpose

Summarize SCM capture operator review readiness records.

## Scope

- Count ready, blocked, missing, and repair-required review candidates.
- Surface evidence counts.
- Keep diagnostics read-only.

## Acceptance Criteria

- [x] Diagnostics summarize review readiness.
- [x] Evidence counts are deterministic.
- [x] Blocker counts are deterministic.
- [x] Diagnostics grant no mutation authority.

## Validation

- `cargo test -p nucleus-server scm_capture_review_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
