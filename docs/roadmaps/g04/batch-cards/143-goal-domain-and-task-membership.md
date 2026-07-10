# 143 Goal Domain And Task Membership

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Implement the missing durable Goal record and make it the canonical grouping
and ordering layer above tasks.

## Work

- add focused goal modules under `nucleus-planning` using the existing
  `PlanningGoalId`
- define proposed, ready, active, blocked, achieved, and abandoned states
- model project, title, desired outcome, scope, owners, ordered task refs,
  planning refs, stop conditions, evidence refs, next task/action, and timestamps
- add goal storage codec and local-store record kind
- make goal revision guard ordered task membership changes
- allow tasks to appear in multiple goals only through each goal's explicit
  membership
- add deterministic membership and lifecycle validation tests

## Acceptance

- goals are durable first-class records rather than planning-only refs
- ordered membership has one authoritative source
- missing, duplicate, cross-project, and over-50 task membership fails closed
- task and goal completion remain distinct
- no provider, workflow, UI, or SCM effects are added

## Evidence

- `crates/nucleus-planning/src/goals.rs`
- `crates/nucleus-planning/src/storage_shape/goals.rs`
- `crates/nucleus-core/src/persistence.rs`
- `crates/nucleus-local-store/src/sqlite/kinds.rs`
- `cargo test -p nucleus-planning -p nucleus-local-store --no-fail-fast`
- `effigy check:rust`
