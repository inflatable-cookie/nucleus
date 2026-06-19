# 271 Codex Recovery Need Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../061-codex-session-recovery-gate.md`

## Purpose

Add Codex recovery need records for sessions that may require resume or repair.

## Scope

- Record runtime, session, provider thread/turn refs, task, and work item refs.
- Classify recovery triggers: process exit, reconnect, server restart, or
  provider identity mismatch.
- Require summary/evidence refs without raw provider payload retention.
- Do not issue resume commands in this card.

## Acceptance Criteria

- [x] Recovery records preserve Nucleus and provider identity.
- [x] Raw provider payload retention is disabled by default.
- [x] Records do not mutate task state.

## Closeout

Added Codex recovery need records under `nucleus-server` with explicit runtime,
session, provider thread/session/turn/request, task, and work-item refs.
Recovery triggers now cover process exit, reconnect, server restart, and
provider identity mismatch. Records are recovery-required by default, issue no
resume command, retain no raw provider payload, and do not permit task
mutation.

Shared Codex supervision test fixtures were extracted while implementing this
card so the recovery lane does not add more duplicated runtime setup.

## Validation

- [x] `cargo test -p nucleus-server recovery_need -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if recovery identity cannot be stable before resume admission.
