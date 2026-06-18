# 170 Management Projection Import Apply Command

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Add a bounded command/service path that applies validated staged project and
task projection records to the active working set.

## Scope

- Add command/input records for management projection apply.
- Apply only staged project and task records that pass validation and policy
  gates.
- Keep the command non-SCM-mutating.
- Preserve staged evidence for review and recovery.

## Acceptance Criteria

- Apply entry points are explicit and testable.
- Clients cannot apply records by mutating repositories directly.
- Unsupported, invalid, or unclassified staged records are retained and
  reported.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if apply requires storage backend assumptions that violate the adapter
  boundary.

## Result

- Added engine-level management projection apply command vocabulary with
  explicit record targets and no SCM mutation authority.
- Added server-side import apply request/report types and a bounded apply
  service for staged project/task projection records.
- Applied records write through `ServerStateService` and backend revision
  expectations rather than direct repository mutation.
- Missing explicit targets and unsupported record kinds are retained as blocked
  apply outcomes.
