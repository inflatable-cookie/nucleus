# 092 Convergence Local Snap Runner Evidence Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../026-convergence-local-snap-runner-evidence-persistence.md`

## Purpose

Expose read-only control counts for persisted Convergence local snap runner
evidence.

## Acceptance Criteria

- [x] DTO reports persisted, duplicate, blocked, and reviewable evidence
  counts.
- [x] DTO exposes no raw command output.
- [x] DTO carries no mutation or backend authority.
- [x] No command or backend effect is added.

## Validation

- `cargo test -p nucleus-server convergence_local_snap_runner_evidence_control_dto -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
