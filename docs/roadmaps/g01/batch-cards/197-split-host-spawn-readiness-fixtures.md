# 197 Split Host Spawn Readiness Fixtures

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Move reusable host-spawn readiness fixtures into a focused sibling module.

## Scope

- Extract authority, supervisor, backend, and interruption fixture builders.
- Keep fixtures test-only unless production code needs them.
- Avoid adding backend implementation behavior.

## Out Of Scope

- Changing readiness behavior.
- Process spawning.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Fixture builders are not embedded in the main readiness module.
- Existing tests still pass.
- Module ownership is clearer for backend implementation.

## Closeout

- Moved host-spawn readiness fixture builders into
  `crates/nucleus-server/src/host_spawn_readiness/fixtures.rs`.
- Main host-spawn readiness module now contains production gate logic only.
- Focused host-spawn readiness tests pass.
