# 446 Task Project Read Model Implementation

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Implement the selected read-model slice after audit and selection.

## Work

- [x] Add focused Rust modules for the selected read model.
- [x] Keep `lib.rs` and module front doors small.
- [x] Add deterministic builders/projections where needed.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Surface is server-owned and deterministic.
- [x] Surface is read-only unless a command-gated mutation contract already
  applies.
- [x] Tests cover ready, filtered, blocked, review, and no-effect states.

## Result

Implemented `crates/nucleus-engine/src/task_readiness.rs`.

The projection:

- classifies task records deterministically by project
- exposes candidate classes, reasons, blockers, evidence refs, status counts,
  and source counts
- keeps `client_can_mutate` and `provider_execution_available` false
- does not implement scoring, task mutation, provider execution, goal loops, or
  UI behavior
