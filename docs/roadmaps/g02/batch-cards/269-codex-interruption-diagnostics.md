# 269 Codex Interruption Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../060-codex-provider-interruption-gate.md`

## Purpose

Expose Codex interruption outcomes through read-only diagnostics.

## Scope

- Add client-safe diagnostics DTOs with next action hints.
- Show authority, recovery, and task-mutation gaps explicitly.
- Do not add desktop panels.
- Do not expose raw provider payloads.

## Acceptance Criteria

- Clients can inspect interruption status without command authority.
- Diagnostics serialize without raw provider data.
- Recovery and task-mutation gaps remain explicit.

## Validation

- targeted serialization tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if diagnostics need UI design decisions.

## Result

- Added client-safe Codex interruption diagnostics.
- Included next action hints for accepted, blocked, failed, and unsupported
  outcomes.
- Kept provider interruption, recovery, and task mutation authority out of the
  read-only DTO.
- Verified serialization does not expose raw provider payload or reason refs.
