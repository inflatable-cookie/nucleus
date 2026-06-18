# 086 Projection Conflict Assistance Routing

Status: completed
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

- [x] Mechanical conflict assistance never hides semantic conflicts.
- [x] Semantic conflicts require human approval.
- [x] Unsupported records remain preserved.

## Outcome

- Added conflict assistance routing records for schema, semantic, unsupported,
  and SCM conflict classes.
- Preserved semantic escalation and unsupported-record handling as explicit
  review states.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if conflict routing needs model output as approval.
