# 055 Convergence Publication Request Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../014-convergence-publication-request-persistence.md`

## Purpose

Define duplicate-safe persistence records for Convergence-like stopped
publication requests.

## Acceptance Criteria

- [x] Persistence records preserve stopped request refs and idempotency keys.
- [x] Duplicate idempotency keys produce duplicate no-op outcomes.
- [x] Blocked request records remain inspectable.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_request_persistence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
