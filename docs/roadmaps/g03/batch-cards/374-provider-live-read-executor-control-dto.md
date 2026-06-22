# 374 Provider Live Read Executor Control DTO

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../094-provider-live-read-executor-control-surface.md`

## Purpose

Add serialized control DTOs for provider live-read executor diagnostics.

## Acceptance Criteria

- [x] DTO exposes sanitized ids, status counts, blocker counts, and no-effect
  flags.
- [x] DTO does not expose raw provider stdout/stderr, headers, or credentials.
- [x] Tests cover serialization hygiene.
