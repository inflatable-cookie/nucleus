# 049 Convergence Publication Admission Records

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../012-convergence-publication-admission.md`

## Purpose

Define stopped-by-default Convergence-like publication admission records from
persisted adapter-neutral chain projections.

## Acceptance Criteria

- [x] Persisted neutral chains with Convergence-like publication stages can be
  admitted.
- [x] Git-like chains are not admitted as Convergence publication.
- [x] Duplicate and blocked persisted projections block admission.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_admission -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
