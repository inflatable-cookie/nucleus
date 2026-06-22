# 379 Provider Live Read Command Handoff Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../095-provider-live-read-executor-command-runner-handoff.md`

## Purpose

Add diagnostics for provider live-read command-runner handoff readiness and
result mapping.

## Acceptance Criteria

- [x] Diagnostics count ready, blocked, parsed, parse-error, and receipt states.
- [x] Diagnostics expose explicit no-effect flags.
- [x] Tests cover blocked write/task/raw-payload cases.
