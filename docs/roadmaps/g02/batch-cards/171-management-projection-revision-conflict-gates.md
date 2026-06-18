# 171 Management Projection Revision Conflict Gates

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Prove that projection apply refuses stale, conflicting, invalid, and
unsupported records without silent state mutation.

## Scope

- Add fixtures for stale expected revisions.
- Add fixtures for semantic task and project conflicts.
- Add fixtures for unsupported schema and invalid record shape.
- Route blocked records into reviewable conflict state.

## Acceptance Criteria

- No stale staged record overwrites newer active state.
- Semantic conflicts are preserved with both sides available for review.
- Schema errors remain distinct from semantic conflicts.
- Unsupported schema records are preserved, not deleted.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if conflict classification needs operator policy beyond the current
  contracts.
