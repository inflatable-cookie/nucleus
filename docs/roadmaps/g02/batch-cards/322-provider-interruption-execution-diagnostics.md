# 322 Provider Interruption Execution Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../071-codex-provider-interruption-execution-gate.md`

## Purpose

Expose Codex provider interruption execution state through read-only
diagnostics.

## Scope

- Show admitted, blocked, completed, failed, timed-out, and cleanup-required
  interruption execution states.
- Include interruption refs, task work refs, write attempt refs, and receipt
  refs.
- Keep diagnostics read-only and sanitized.

## Acceptance Criteria

- [x] Diagnostics show interruption execution linkage.
- [x] Diagnostics do not expose raw provider content.
- [x] Diagnostics do not grant provider, task, review, callback, resume, or SCM
      authority.

## Validation

- targeted server tests
- `cargo check --workspace`
