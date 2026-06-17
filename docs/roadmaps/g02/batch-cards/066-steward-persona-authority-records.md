# 066 Steward Persona Authority Records

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../018-steward-native-harness-and-effigy-tools.md`

## Purpose

Make the project steward authority model executable in Rust records.

## Scope

- Extend or refine native harness persona policy records for steward authority.
- Keep management-state authority separate from source-code mutation.
- Make privileged actions, approval requirements, commit authority, push
  authority, and model-backend neutrality explicit.
- Add focused tests proving the project steward cannot gain source-code
  mutation authority through backend choice.

## Acceptance Criteria

- [x] Steward persona policy can represent propose-only, prepare-capture,
  create-capture, and share-capture authority.
- [x] Policy records distinguish management-state edits from code mutation.
- [x] Privileged actions require approval unless policy explicitly permits them.
- [x] Local versus cloud backend choice does not increase steward authority.

## Outcome

Added explicit steward authority helpers to `nucleus-native-harness` persona
policy records.

The policy surface now covers management capture tiers, privileged action
approval outcomes, source-code mutation blocking, and backend authority
neutrality.

## Validation

- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if steward authority needs autonomous source-code mutation.
- Stop if policy cannot be represented without changing task or SCM contracts.
