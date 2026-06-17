# 198 Split Local Host Runtime Discovery Tests

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Move local host runtime discovery tests out of the core vocabulary module if
the split reduces module growth.

## Scope

- Extract discovery tests into a sibling test module.
- Keep public discovery vocabulary and fixture exports unchanged.
- Preserve discovery-to-gate composition coverage.

## Out Of Scope

- Changing discovery behavior.
- Implementing backend probes.
- Process spawning.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Discovery tests still pass.
- Core discovery module remains focused on vocabulary and value builders.
- No public API names change.

## Closeout

- Moved local host runtime discovery tests into
  `crates/nucleus-server/src/local_host_runtime_discovery/tests.rs`.
- Core discovery module now keeps vocabulary, composition, and the exported
  unsupported fixture.
- Focused discovery tests pass.
