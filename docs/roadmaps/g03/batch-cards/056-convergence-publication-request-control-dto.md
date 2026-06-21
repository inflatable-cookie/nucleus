# 056 Convergence Publication Request Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../014-convergence-publication-request-persistence.md`

## Purpose

Expose Convergence-like publication request persistence diagnostics through
read-only control DTOs.

## Acceptance Criteria

- [x] DTOs summarize persisted, duplicate, blocked, and stopped counts.
- [x] DTOs preserve no raw provider payloads.
- [x] DTOs carry no mutation authority.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_request_control -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
