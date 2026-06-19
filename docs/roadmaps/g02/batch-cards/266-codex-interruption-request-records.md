# 266 Codex Interruption Request Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../060-codex-provider-interruption-gate.md`

## Purpose

Add Codex interruption request records for provider-running work.

## Scope

- Record runtime, session, turn, task, work item, and requested interruption
  target refs.
- Preserve provider turn/request ids where available.
- Require an explicit reason summary without raw provider payload retention.
- Do not send interruption commands in this card.

## Acceptance Criteria

- Interruption request records preserve provider and Nucleus identity.
- Raw provider payload retention is disabled by default.
- Records do not mutate task state.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if interruption identity cannot be stable before provider send.

## Result

- Added Codex interruption request records for active provider turns.
- Preserved runtime, session, provider turn/request, task, and work item refs.
- Required a reason summary/ref and blocked raw reason/provider payload
  retention.
- Kept provider send, recovery, and task mutation out of scope.
