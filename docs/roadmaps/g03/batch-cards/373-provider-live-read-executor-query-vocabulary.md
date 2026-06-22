# 373 Provider Live Read Executor Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../094-provider-live-read-executor-control-surface.md`

## Purpose

Define the server query vocabulary for inspecting provider live-read executor
diagnostics.

## Acceptance Criteria

- [x] Query names the executor diagnostics surface without implying provider
  writes.
- [x] Query shape is read-only and carries no credential material.
- [x] Stop conditions remain explicit for provider writes and task mutation.
