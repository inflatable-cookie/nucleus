# 057 Work Item Review Acceptance Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../015-task-backed-agent-work-unit-proof.md`

## Purpose

Represent operator review and task acceptance separately from agent runtime
completion.

## Scope

- Add review-state records for a task work item.
- Represent accepted, rejected, needs-changes, and abandoned outcomes.
- Link validation and checkpoint evidence.
- Keep merge/PR behavior for later SCM workflow milestones.

## Acceptance Criteria

- [x] Agent completion can leave a work item awaiting review.
- [x] Operator acceptance can be recorded as a distinct state transition.
- [x] Validation/checkpoint refs can support review decisions.
- [x] Task completion is not automatic unless policy explicitly allows it
  later.

## Outcome

- Added task work-item review decision and transition records.
- Supported accepted, rejected, needs-changes, and abandoned outcomes.
- Required completed runtime plus validation or checkpoint evidence before
  review can be recorded.
- Kept task completion explicitly disabled by the work-item review transition.

## Validation

- [x] `cargo test -p nucleus-engine task`
- [x] `cargo test -p nucleus-server task`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if review acceptance needs unresolved SCM merge or forge policy.
