# 395 Live Provider Evidence Work Observations

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../086-durable-live-evidence-task-work-linkage.md`

## Purpose

Persist task-work runtime observations from durable live provider-write
evidence candidates.

## Scope

- Persist observation records by task/work/evidence refs.
- Link runtime receipt and live executor outcome ids.
- Reject raw provider material, raw streams, task mutation, and review
  acceptance.
- Preserve duplicate observation handling.

## Acceptance Criteria

- [x] Observation records survive reopen.
- [x] Duplicate observations are deterministic.
- [x] Raw material and widened authority are rejected.
- [x] Receipts/outcomes remain reference-only.

## Result

Added persisted live provider evidence work observations with duplicate no-op,
raw-material blockers, and no mutation authority.

## Validation

- `cargo test -p nucleus-server live_provider_evidence_work_observations -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
