# 086 Projection Conflict Assistance Routing

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../021-management-projection-sync-runtime.md`

## Purpose

Route projection conflict reports to mechanical repair or semantic escalation.

## Scope

- Map schema, semantic, unsupported, and SCM conflict classes to assistance
  records.
- Keep mechanical and semantic flows separate.
- Link conflict reports and evidence refs.

## Acceptance Criteria

- Mechanical conflict assistance never hides semantic conflicts.
- Semantic conflicts require human approval.
- Unsupported records remain preserved.

## Validation

- `cargo test -p nucleus-engine management_projection`
- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if conflict routing needs model output as approval.
