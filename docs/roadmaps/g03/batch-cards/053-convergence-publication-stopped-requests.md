# 053 Convergence Publication Stopped Requests

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../013-convergence-publication-command-boundary.md`

## Purpose

Create stopped request/handoff records for Convergence-like publication
descriptors.

## Acceptance Criteria

- [x] Request records preserve preflight, descriptor, projection, task, repo,
  and provider-stage refs.
- [x] Request records include stable idempotency refs.
- [x] Blocked descriptors cannot request handoff.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_publication_stopped_requests -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
