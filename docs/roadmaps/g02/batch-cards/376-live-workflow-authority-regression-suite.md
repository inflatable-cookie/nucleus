# 376 Live Workflow Authority Regression Suite

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../082-task-backed-live-workflow-closeout.md`

## Purpose

Add regression tests proving live workflow surfaces fail closed on authority
widening.

## Scope

- Cover provider writes, callback answering, cancellation, resume, task
  mutation, review acceptance, SCM mutation, raw payload retention, and raw
  stream retention.
- Prefer targeted tests over broad brittle suites.

## Acceptance Criteria

- [ ] Authority widening fails closed across runtime surfaces.
- [ ] Raw material retention is rejected.
- [ ] Task/review/SCM authority remains separately gated.
- [ ] Tests are scoped and maintainable.

## Validation

- `cargo test -p nucleus-server live_workflow_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
