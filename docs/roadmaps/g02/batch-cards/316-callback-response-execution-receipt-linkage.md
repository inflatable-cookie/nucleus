# 316 Callback Response Execution Receipt Linkage

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../070-codex-callback-response-execution-gate.md`

## Purpose

Link Codex callback response execution attempts to runtime receipts.

## Scope

- Add reference-only linkage from callback response execution state to runtime
  receipt ids.
- Preserve provider callback response completion as runtime progress, not task
  completion or review acceptance.
- Add tests for completed, failed, timed-out, blocked, and cleanup-required
  outcomes.

## Acceptance Criteria

- [x] Receipt linkage survives projection without provider material.
- [x] Provider callback response completion does not imply review acceptance.
- [x] Failed and timed-out outcomes stay inspectable.

## Validation

- targeted server tests
- `cargo check --workspace`
