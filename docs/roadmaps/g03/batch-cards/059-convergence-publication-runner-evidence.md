# 059 Convergence Publication Runner Evidence

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../015-convergence-publication-runner-proof.md`

## Purpose

Capture sanitized, non-mutating evidence for Convergence-like publication
runner proof records.

## Acceptance Criteria

- [x] Evidence records preserve proof, request, idempotency, task, repo, and
  provider-stage refs.
- [x] Evidence records contain bounded counts/status only.
- [x] Raw provider output is not retained.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_runner_evidence -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
