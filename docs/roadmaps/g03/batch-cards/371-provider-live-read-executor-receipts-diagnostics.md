# 371 Provider Live Read Executor Receipts Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../093-provider-live-read-server-owned-executor.md`

## Purpose

Add runtime receipts and diagnostics for server-owned live reads.

## Acceptance Criteria

- [x] Receipts state provider network read performed or blocked.
- [x] Diagnostics count ready, blocked, executed, parse-error, and sanitized
  evidence states.
- [x] No provider write, task mutation, callback, interruption, or recovery
  execution is represented as performed.
