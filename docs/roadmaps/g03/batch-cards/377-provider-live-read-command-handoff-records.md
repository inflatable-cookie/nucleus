# 377 Provider Live Read Command Handoff Records

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../095-provider-live-read-executor-command-runner-handoff.md`

## Purpose

Create read-only command-runner handoff records from ready provider live-read
executor descriptors.

## Acceptance Criteria

- [x] Handoff records reference executor request and command descriptor ids.
- [x] Handoff records carry only executable/argv and sanitized refs.
- [x] Provider writes, task mutation, and raw payload retention are blocked.
