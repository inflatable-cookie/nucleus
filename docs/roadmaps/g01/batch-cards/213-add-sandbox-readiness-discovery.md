# 213 Add Sandbox Readiness Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Produce sandbox readiness from the local sandbox backend.

## Scope

- Discover enforced profiles.
- Report enforcement posture.
- Produce sandbox evidence refs.
- Keep unsupported or advisory-only sandbox blocked.

## Out Of Scope

- Process spawn.
- Platform hardening implementation.
- Desktop UI.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Discovery reports concrete local sandbox readiness.
- Missing evidence blocks readiness.
- Tests remain non-spawning.
