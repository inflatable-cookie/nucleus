# 075 Native Steward Command Admission

Status: completed
Owner: Tom
Updated: 2026-06-18
Milestone: `../019-native-steward-command-boundary.md`

## Purpose

Add authority checks for native steward command requests.

## Scope

- Classify read-only, proposal-only, approval-required, and unsupported command
  scopes.
- Reject source mutation, unauthorized sync escalation, and provider auth
  mutation.
- Keep persona policy as the authority source.

## Acceptance Criteria

- [x] Read-only commands can be accepted without approval.
- [x] Semantic or sync-sensitive commands require approval.
- [x] Unsupported authority escalation is rejected before execution.

## Outcome

- Added native steward command admission records.
- Mapped command scope and persona policy to accepted, requires-approval,
  rejected, blocked, and unsupported states.
- Proved unsupported escalation and proposal authority gaps are rejected before
  execution.

## Validation

- [x] `cargo test -p nucleus-native-harness steward`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `git diff --check`

## Stop Conditions

- Stop if admission depends on model backend kind instead of persona policy.
