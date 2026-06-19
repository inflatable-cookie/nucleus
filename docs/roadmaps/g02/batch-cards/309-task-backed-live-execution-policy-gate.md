# 309 Task-Backed Live Execution Policy Gate

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../069-codex-task-backed-live-execution-gate.md`

## Purpose

Define the server policy gate that decides whether a task work item may enter
the Codex live executor path.

## Scope

- Name required task work item, runtime, adapter, host, and operator evidence.
- Name the goal, loop, or roadmap pathway evidence required for the live
  execution attempt.
- Keep tool exposure behind portal-tool and adapter capability policy.
- Block callback response, cancellation, resume, task completion, review
  acceptance, SCM mutation, and raw provider material retention.
- Add compile-time records and tests only.

## Acceptance Criteria

- [x] Gate records compile in focused modules.
- [x] Tests cover accepted and blocked decisions.
- [x] Records do not execute provider writes.
- [x] Records do not grant task mutation or review authority.
- [x] Records do not rely on invented next-task state.
- [x] Records do not expose a large flat tool menu to the agent.

## Validation

- targeted server tests
- `cargo check --workspace`
