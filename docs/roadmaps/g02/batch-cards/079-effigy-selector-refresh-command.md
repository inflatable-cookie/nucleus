# 079 Effigy Selector Refresh Command

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Map read-only Effigy selector refresh evidence into selector inventory records.

## Scope

- Add command result records for `effigy tasks` selector refresh.
- Preserve scope, selector refs, command-scope hints, and evidence refs.
- Do not execute selectors.

## Acceptance Criteria

- Selector refresh can update inventory from sanitized command evidence.
- Selector refs remain stable and scoped.
- Raw command output is not persisted as task history.

## Validation

- `cargo test -p nucleus-native-harness effigy`
- `cargo test -p nucleus-engine runtime_receipt`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if selector execution is required.
