# 137 Task Work Unit Diagnostics Read Model

Status: completed
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

- [x] Clients can inspect work units.
- [x] DTOs do not expose provider payloads.
- [x] DTOs cannot mutate state.

## Result

Added task-agent diagnostics read models, control API diagnostics domain,
control response DTO snapshot support, request decoding, and desktop DTO
types.

## Validation

- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need provider runtime state not yet modeled.
