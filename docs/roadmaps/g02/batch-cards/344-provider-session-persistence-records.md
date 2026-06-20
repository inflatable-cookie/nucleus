# 344 Provider Session Persistence Records

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../076-codex-provider-session-and-stdio-persistence.md`

## Purpose

Persist sanitized provider session binding records.

## Scope

- Record provider instance, runtime session, thread/session refs, lifecycle
  state, evidence refs, and repair state.
- Reject secret/raw provider material.
- Keep persistence read-only with respect to provider transports.

## Acceptance Criteria

- [ ] Session bindings survive local-store reopen.
- [ ] Missing or mismatched identity blocks persistence.
- [ ] Raw provider material is not stored.
- [ ] No provider write or task mutation authority is granted.

## Validation

- `cargo test -p nucleus-server provider_session_persistence -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
