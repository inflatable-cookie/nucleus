# 398 Provider Live Read Smoke Evidence Handler State Route

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../100-provider-live-read-smoke-evidence-state-backed-query.md`

## Purpose

Route smoke evidence control queries through handler-owned state.

## Acceptance Criteria

- [x] Request handler passes `handler.state()` to the composer.
- [x] Local-store errors map to `ServerControlError`.
- [x] Control query remains read-only.
