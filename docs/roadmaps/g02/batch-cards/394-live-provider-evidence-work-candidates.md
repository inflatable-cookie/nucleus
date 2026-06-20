# 394 Live Provider Evidence Work Candidates

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../086-durable-live-evidence-task-work-linkage.md`

## Purpose

Project reconciled durable live provider-write evidence into task work progress
candidates.

## Scope

- Accept only reconciled durable live provider-write replay records.
- Carry task id, work item id, evidence id, receipt id, outcome id, thread id,
  and turn id by reference.
- Represent terminal states without task completion.
- Keep review acceptance separate.

## Acceptance Criteria

- [x] Reconciled evidence creates a progress candidate.
- [x] Missing replay/evidence fields create repair-required candidates.
- [x] Task completion is not inferred.
- [x] Review acceptance is not inferred.

## Result

Added reference-only live provider evidence work candidates with repair-required
gaps and no task/review promotion.

## Validation

- `cargo test -p nucleus-server live_provider_evidence_work_candidates -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
