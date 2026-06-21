# 058 Convergence Publication Runner Proof Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../015-convergence-publication-runner-proof.md`

## Purpose

Define stopped runner proof records from persisted Convergence-like publication
requests.

## Acceptance Criteria

- [x] Persisted request records can produce runner proof records.
- [x] Duplicate and blocked persistence records are skipped.
- [x] Idempotency refs are preserved.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_runner_proof -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
