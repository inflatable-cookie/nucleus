# 079 Effigy Selector Refresh Command

Status: completed
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

- [x] Selector refresh can update inventory from sanitized command evidence.
- [x] Selector refs remain stable and scoped.
- [x] Raw command output is not persisted as task history.

## Outcome

- Added selector-refresh summary records for read-only `effigy tasks`
  evidence.
- Added inventory update behavior gated by sanitized refs.
- Confirmed selector refresh summaries cannot execute selectors.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo test -p nucleus-engine runtime_receipt`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if selector execution is required.
