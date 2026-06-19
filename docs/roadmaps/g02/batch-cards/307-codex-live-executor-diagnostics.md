# 307 Codex Live Executor Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../068-codex-live-executor-integration.md`

## Purpose

Expose live Codex executor outcomes through read-only diagnostics.

## Scope

- Add diagnostics records for live executor attempts.
- Show blocked, executed, completed, failed, timed-out, and cleanup-required
  states.
- Keep diagnostics read-only and sanitized.
- Add request-handler query tests.

## Acceptance Criteria

- [x] Diagnostics do not expose raw provider content.
- [x] Diagnostics do not grant provider command authority.
- [x] Query tests cover empty, completed, failed, and timeout states.

## Validation

- targeted server tests
- `cargo check --workspace`
