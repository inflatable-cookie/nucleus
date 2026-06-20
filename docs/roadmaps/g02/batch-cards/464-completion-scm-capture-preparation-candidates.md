# 464 Completion SCM Capture Preparation Candidates

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../100-completion-scm-capture-preparation-records.md`

## Purpose

Create provider-neutral capture-preparation candidates from persisted accepted
capture admissions.

## Scope

- Consume persisted capture admissions.
- Preserve readiness/candidate/task/work/completion/operator/evidence refs.
- Skip blocked admissions.
- Keep records non-mutating.

## Acceptance Criteria

- [x] Accepted admissions create preparation candidates.
- [x] Blocked admissions are skipped.
- [x] Candidate records retain refs only.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_capture_preparation_candidates -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
