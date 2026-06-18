# 085 Projection Import Repair Proposals

Status: completed
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

- [x] Invalid imports produce repair evidence instead of silent overwrite.
- [x] Unsupported schema records are preserved.
- [x] Semantic repair requires approval.

## Outcome

- Added import repair proposal records for invalid and unsupported projection
  reports.
- Preserved incoming records and blocked silent task-meaning overwrites.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if import repair would rewrite task meaning automatically.
