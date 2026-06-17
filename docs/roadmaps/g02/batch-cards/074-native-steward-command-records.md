# 074 Native Steward Command Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../019-native-steward-command-boundary.md`

## Purpose

Add record-only native steward command requests and outcomes.

## Scope

- Add command request records for read-only inspection, proposal drafting,
  capture preparation, sync assistance, and Effigy inspection.
- Add command outcome records that are distinct from proposals and mutations.
- Link commands to persona, tool action, receipt, and sanitized evidence refs.
- Do not implement live steward execution.

## Acceptance Criteria

- [x] Steward commands are distinct from steward proposals.
- [x] Commands can represent accepted, rejected, blocked, completed, and unknown
  outcomes.
- [x] Command records cannot imply commit, push, publication, or forge execution.

## Outcome

- Added record-only native steward command request and outcome records.
- Added first command kinds for read-only inspection, proposal drafting,
  management capture preparation, sync assistance, and Effigy inspection.
- Kept provider authority, mutation, commit, push, publication, and forge calls
  impossible to imply from command records.

## Validation

- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if command records need to mutate project, SCM, or forge state.
