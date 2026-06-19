# 312 Task-Backed Live Execution Diagnostics

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../069-codex-task-backed-live-execution-gate.md`

## Purpose

Expose task-backed Codex live execution state through read-only diagnostics.

## Scope

- Show admitted, blocked, completed, failed, timed-out, and cleanup-required
  task-backed live execution states.
- Include task work item refs, live executor refs, and receipt refs.
- Keep diagnostics read-only and sanitized.

## Acceptance Criteria

- [ ] Diagnostics show task work and live executor linkage.
- [ ] Diagnostics do not expose raw provider content.
- [ ] Diagnostics do not grant provider, task, review, callback, cancellation,
      resume, or SCM authority.

## Validation

- targeted server tests
- `cargo check --workspace`
