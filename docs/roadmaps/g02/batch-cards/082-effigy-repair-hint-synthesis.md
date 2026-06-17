# 082 Effigy Repair Hint Synthesis

Status: completed
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

- [x] Repair hints are categorized and evidence-backed.
- [x] Manifest or docs fixes remain proposals.
- [x] No repair hint mutates files directly.

## Outcome

- Added Effigy repair synthesis records.
- Converted sanitized Effigy findings into review-only steward proposals.
- Confirmed repair synthesis does not edit manifests, scripts, or task state.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if repair requires manifest mutation.
