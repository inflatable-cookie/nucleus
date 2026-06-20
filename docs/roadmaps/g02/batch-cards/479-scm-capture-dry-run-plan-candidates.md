# 479 SCM Capture Dry Run Plan Candidates

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../103-scm-capture-driver-dry-run-planning.md`

## Purpose

Create SCM capture dry-run plan candidates from persisted ready preparation
records.

## Scope

- Consume persisted preparation records.
- Preserve refs, labels, status, and evidence refs.
- Skip unsupported and repair-required preparation records.
- Keep records non-mutating.

## Acceptance Criteria

- [x] Ready persisted preparation records create dry-run candidates.
- [x] Unsupported and repair-required records are skipped.
- [x] Candidate records retain refs only.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server scm_capture_dry_run_plan_candidates -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
