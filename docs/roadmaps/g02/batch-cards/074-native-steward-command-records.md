# 074 Native Steward Command Records

Status: ready
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

- Steward commands are distinct from steward proposals.
- Commands can represent accepted, rejected, blocked, completed, and unknown
  outcomes.
- Command records cannot imply commit, push, publication, or forge execution.

## Validation

- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if command records need to mutate project, SCM, or forge state.
