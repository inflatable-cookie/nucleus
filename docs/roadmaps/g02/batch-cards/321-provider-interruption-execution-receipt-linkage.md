# 321 Provider Interruption Execution Receipt Linkage

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../071-codex-provider-interruption-execution-gate.md`

## Purpose

Link Codex interruption execution attempts to runtime receipts.

## Scope

- Add reference-only linkage from interruption execution state to runtime
  receipt ids.
- Preserve provider interruption completion as runtime progress, not task
  completion or review acceptance.
- Add tests for completed, failed, timed-out, blocked, and cleanup-required
  outcomes.

## Acceptance Criteria

- [ ] Receipt linkage survives projection without provider material.
- [ ] Provider interruption completion does not imply review acceptance.
- [ ] Failed and timed-out outcomes stay inspectable.

## Validation

- targeted server tests
- `cargo check --workspace`
