# 196 Split Host Spawn Readiness Tests

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Move host-spawn readiness tests out of the main readiness module.

## Scope

- Create a sibling test module for host-spawn readiness.
- Keep public types and functions unchanged.
- Preserve all existing assertions.

## Out Of Scope

- Changing readiness behavior.
- Implementing backend IO.
- Process spawning.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Host-spawn readiness tests still pass.
- `host_spawn_readiness.rs` is smaller.
- No public API names change.

## Closeout

- Moved host-spawn readiness assertions into
  `crates/nucleus-server/src/host_spawn_readiness/tests.rs`.
- Focused host-spawn readiness tests pass.
- Public readiness names are unchanged.
