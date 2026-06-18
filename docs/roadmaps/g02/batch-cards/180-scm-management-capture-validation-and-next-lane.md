# 180 SCM Management Capture Validation And Next Lane

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../039-scm-management-capture-and-share-foundation.md`

## Purpose

Validate the capture/share foundation lane and choose the next workflow
checkpoint.

## Scope

- Run targeted capture/share tests.
- Run workspace-wide Rust checks.
- Run Northstar/docs validation.
- Promote findings into contracts or architecture.
- Select the next lane from the long-term plan.

## Acceptance Criteria

- Capture/share preparation records and review state are covered by tests.
- Roadmap and gap indexes match implemented state.
- The next lane is explicit and not a micro-card continuation.

## Validation

- Targeted Rust tests for management capture/share behavior.
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if validation exposes provider-specific SCM assumptions in core capture
  records.
