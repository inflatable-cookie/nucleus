# 317 Callback Response Execution Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../070-codex-callback-response-execution-gate.md`

## Purpose

Expose Codex callback response execution state through read-only diagnostics.

## Scope

- Show admitted, blocked, completed, failed, timed-out, and cleanup-required
  callback response execution states.
- Include callback refs, task work refs, write attempt refs, and receipt refs.
- Keep diagnostics read-only and sanitized.

## Acceptance Criteria

- [x] Diagnostics show callback response execution linkage.
- [x] Diagnostics do not expose raw provider content.
- [x] Diagnostics do not grant provider, task, review, callback, cancellation,
      resume, or SCM authority.

## Validation

- targeted server tests
- `cargo check --workspace`
