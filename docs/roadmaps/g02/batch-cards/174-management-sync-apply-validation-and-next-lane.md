# 174 Management Sync Apply Validation And Next Lane

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../038-management-sync-apply-and-review.md`

## Purpose

Validate the apply/review lane and choose the next workflow checkpoint.

## Scope

- Run targeted management sync tests.
- Run workspace-wide Rust checks.
- Run Northstar/docs validation.
- Promote findings into contracts or architecture.
- Select the next lane from the long-term plan.

## Acceptance Criteria

- Apply, conflict, receipt, and review behavior is covered by tests.
- Roadmap and gap indexes match implemented state.
- The next lane is explicit and not a micro-card continuation.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if validation exposes projection authority drift or unsafe apply
  behavior.
