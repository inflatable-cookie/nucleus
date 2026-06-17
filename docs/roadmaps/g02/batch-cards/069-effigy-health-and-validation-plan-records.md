# 069 Effigy Health And Validation Plan Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Represent Effigy doctor and `effigy test --plan` summaries as steward evidence.

## Scope

- Add sanitized records for health summaries, test-plan summaries, and repair
  hints.
- Link records to native tool actions and runtime receipts where available.
- Distinguish planning evidence from executed validation evidence.
- Do not persist raw command output.

## Acceptance Criteria

- [x] Health summaries can represent ok, warning, error, blocked, and unknown.
- [x] Validation plans can describe selectors without claiming tests ran.
- [x] Raw Effigy output is excluded from durable task history.

## Outcome

- Added native Effigy health summary records with status, scope, tool action
  link, runtime receipt refs, evidence refs, and repair hints.
- Added native Effigy validation-plan records that describe planned selectors
  without claiming execution.
- Updated native harness and runtime receipt contracts to keep Effigy evidence
  summary-only.

## Validation

- [x] `cargo test -p nucleus-native-harness effigy`
- [x] `cargo test -p nucleus-engine runtime_receipt`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if raw Effigy output must be stored as task history.
