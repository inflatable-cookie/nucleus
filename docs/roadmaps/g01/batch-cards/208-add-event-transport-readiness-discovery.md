# 208 Add Event Transport Readiness Discovery

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Produce event transport readiness from the local event transport backend.

## Scope

- Discover supported supervision event kinds.
- Report delivery readiness.
- Report replay readiness evidence.
- Keep unsupported or incomplete transport blocked.

## Out Of Scope

- Remote clients.
- Live UI subscriptions.
- Process spawn.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Discovery reports concrete in-process transport readiness.
- Missing delivery evidence blocks event transport readiness.
- Missing replay evidence blocks event transport readiness.
- Tests remain non-spawning.
