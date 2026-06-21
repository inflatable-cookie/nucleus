# 068 Convergence Runner Evidence Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../018-convergence-runner-evidence-persistence.md`

## Purpose

Expose runner evidence persistence through read-only control DTOs.

## Acceptance Criteria

- [x] DTOs summarize persisted, duplicate, blocked, and reviewable counts.
- [x] DTOs expose no raw provider payloads.
- [x] DTOs carry no mutation authority.
- [x] No execution effect is added.

## Validation

- `cargo test -p nucleus-server convergence_runner_evidence_control -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
