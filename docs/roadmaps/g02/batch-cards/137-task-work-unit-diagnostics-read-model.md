# 137 Task Work Unit Diagnostics Read Model

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../031-task-agent-work-unit-source-model.md`

## Purpose

Expose task work-unit state through client-safe diagnostics.

## Scope

- Add server read model DTOs.
- Include source status and provenance refs.
- Keep mutation fields absent.

## Acceptance Criteria

- Clients can inspect work units.
- DTOs do not expose provider payloads.
- DTOs cannot mutate state.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need provider runtime state not yet modeled.
