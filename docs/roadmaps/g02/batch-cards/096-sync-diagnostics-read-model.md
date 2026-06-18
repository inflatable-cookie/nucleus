# 096 Sync Diagnostics Read Model

Status: completed
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

- [x] Clients can inspect sync plan and conflict state.
- [x] Semantic conflict state is visible.
- [x] Read models cannot commit, push, or publish.

## Outcome

- Added management projection sync diagnostics DTOs for plans, repair
  proposals, assistance routes, and capture preparations.
- Kept provider mutation unavailable through read models.

## Validation

- [x] `cargo test -p nucleus-server management_projection`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if read models become sync commands.
