# 082 Effigy Repair Hint Synthesis

Status: ready
Owner: Tom
Updated: 2026-06-18
Milestone: `../020-effigy-command-backed-inspection.md`

## Purpose

Convert Effigy inspection findings into repair hints and steward proposals.

## Scope

- Map missing manifest, missing selector, doctor warning, doctor error, plan
  unavailable, and policy-blocked evidence into repair hints.
- Route repair hints into proposal records when appropriate.
- Do not edit `effigy.toml` or project scripts.

## Acceptance Criteria

- Repair hints are categorized and evidence-backed.
- Manifest or docs fixes remain proposals.
- No repair hint mutates files directly.

## Validation

- `cargo test -p nucleus-native-harness effigy`
- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if repair requires manifest mutation.
