# 096 Sync Diagnostics Read Model

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../023-client-read-model-and-diagnostics-runway.md`

## Purpose

Expose management projection sync plans, validation reports, and conflict
assistance to clients.

## Scope

- Add read-model records or DTOs for sync diagnostics.
- Separate mechanical repair from semantic escalation.
- Keep provider mutation unavailable through read models.

## Acceptance Criteria

- Clients can inspect sync plan and conflict state.
- Semantic conflict state is visible.
- Read models cannot commit, push, or publish.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if read models become sync commands.
