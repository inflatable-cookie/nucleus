# 311 Task Work Live Executor Receipt Linkage

Status: ready
Owner: Tom
Updated: 2026-06-19
Milestone: `../069-codex-task-backed-live-execution-gate.md`

## Purpose

Link task work items to Codex live executor outcomes and runtime receipts.

## Scope

- Add reference-only linkage from task work item state to live executor outcome
  id and runtime receipt id.
- Preserve provider completion as runtime progress, not task completion.
- Add tests for completed, failed, timed-out, and cleanup-required outcomes.

## Acceptance Criteria

- [ ] Receipt linkage survives projection without provider material.
- [ ] Provider completion does not imply review acceptance.
- [ ] Failed and timed-out outcomes stay inspectable.

## Validation

- targeted engine/server tests
- `cargo check --workspace`
