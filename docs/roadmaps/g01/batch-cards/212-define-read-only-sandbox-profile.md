# 212 Define Read-Only Sandbox Profile

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first enforceable local sandbox profile for read-only command work.

## Scope

- Target `NoFilesystemWrite`.
- Name evidence needed to claim enforcement.
- Keep advisory-only posture blocked for spawn readiness.

## Out Of Scope

- Process spawn.
- Write-enabled profiles.
- Platform-specific escalation paths.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- `NoFilesystemWrite` can be represented as enforced.
- Advisory-only posture remains a blocker.
- Unsupported posture remains a blocker.
