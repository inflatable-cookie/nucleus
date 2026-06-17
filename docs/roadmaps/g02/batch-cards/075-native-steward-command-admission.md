# 075 Native Steward Command Admission

Status: planned
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

- Read-only commands can be accepted without approval.
- Semantic or sync-sensitive commands require approval.
- Unsupported authority escalation is rejected before execution.

## Validation

- `cargo test -p nucleus-native-harness steward`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if admission depends on model backend kind instead of persona policy.
