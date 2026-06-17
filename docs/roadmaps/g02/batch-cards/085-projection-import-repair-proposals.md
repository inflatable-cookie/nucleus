# 085 Projection Import Repair Proposals

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../021-management-projection-sync-runtime.md`

## Purpose

Route invalid, unsupported, or risky projection imports into repair proposals.

## Scope

- Map validation reports into steward proposal targets.
- Preserve unsupported records.
- Separate schema repair from semantic repair.

## Acceptance Criteria

- Invalid imports produce repair evidence instead of silent overwrite.
- Unsupported schema records are preserved.
- Semantic repair requires approval.

## Validation

- `cargo test -p nucleus-engine management_projection`
- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if import repair would rewrite task meaning automatically.
