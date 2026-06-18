# 169 Management Projection Apply Policy Contract

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Define when staged management projection records may be applied into active
server state.

## Scope

- Promote import-apply authority into the storage and SCM sync contracts.
- Define explicit no-silent-overwrite rules for project and task projection
  records.
- Define expected-revision, unsupported-schema, invalid-record, and semantic
  conflict gates.
- Keep SCM capture, publication, push, promotion, merge, and review-request
  behavior out of the apply boundary.

## Acceptance Criteria

- Contracts distinguish validation, staging, apply, and SCM sharing.
- Apply authority is engine/server-state authority, not client authority.
- Stale or conflicting staged records require review instead of overwrite.
- The policy stays SCM-neutral and does not assume Git commits.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if applying projected records requires a new product decision about
  conflict resolution semantics.
