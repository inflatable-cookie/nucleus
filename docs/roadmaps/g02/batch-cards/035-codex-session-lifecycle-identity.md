# 035 Codex Session Lifecycle Identity

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../011-codex-app-server-runtime-runway.md`

## Purpose

Map Codex thread/session/turn/item/request ids into Nucleus lifecycle and
timeline identity records.

## Scope

- Add or extend type-only lifecycle mapping records for Codex app-server.
- Preserve Codex thread id, session id, turn id, item id, request id, and
  approval/user-input ids where available.
- Mark any synthesized Nucleus ids as synthetic in metadata.
- Add tests for create, resume, send-turn, interrupt, read, rollback/fork
  capability declaration, and recovery fallback records.
- Keep live protocol execution out of scope.

## Acceptance Criteria

- Nucleus session ids remain authoritative.
- Codex provider ids are retained as refs, not promoted to Nucleus ids.
- Resume and recovery failure are explicit states.
- Rollback/fork/read are capabilities, not assumed universal lifecycle
  actions.

## Validation

- `cargo test -p nucleus-agent-protocol`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the current event/timeline identity types cannot represent Codex
  without broad refactoring.
- Stop if provider rollback would be confused with filesystem rollback.

## Outcome

Added `crates/nucleus-agent-protocol/src/codex.rs` with type-only Codex
app-server lifecycle identity records, provider refs, lifecycle method mapping,
id-source markers, and explicit resume fallback.

Tests prove Nucleus session ids remain authoritative, Codex provider ids are
retained as refs, verified lifecycle methods are named, and resume fallback is
an explicit recovery state.
