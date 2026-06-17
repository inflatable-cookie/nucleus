# 162 Add Process Supervisor Acceptance Skeleton

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add a non-spawning process supervisor acceptance skeleton.

## Scope

- Accept or reject readiness plans.
- Emit evidence-ref based event values.
- Keep sandbox enforcement blockers explicit.

## Out Of Scope

- Child process spawning.
- PTY streaming.
- Artifact payload writes.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Acceptance skeleton rejects blocked readiness.
- Ready acceptance emits queued/accepted event values only.
- No child process is spawned.

## Closeout

- Added non-spawning process supervisor acceptance request and decision types.
- Acceptance checks execution authority and process supervision readiness.
- Ready acceptance emits accepted and queued events only.
- Rejections emit blocked event values and keep readiness blockers visible.
