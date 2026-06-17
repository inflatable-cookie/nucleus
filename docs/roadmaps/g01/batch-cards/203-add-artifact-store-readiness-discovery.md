# 203 Add Artifact Store Readiness Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Produce artifact-store readiness from the local artifact backend.

## Scope

- Discover supported payload classes.
- Report payload storage readiness.
- Produce retention and redaction evidence refs.

## Out Of Scope

- Process spawn.
- Event transport implementation.
- Sandbox implementation.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Discovery reports concrete filesystem artifact readiness.
- Unsupported or misconfigured storage keeps artifact readiness blocked.
- Tests remain non-spawning.
