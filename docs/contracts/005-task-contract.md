# 005 Task Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the durable task model for project planning and agent-ready work.

Tasks are first-class records. They are not loose checklist items and should
carry enough context for a human or agent to understand scope, acceptance, and
validation.

## Task Identity

Each task must expose:

- stable task id
- project id
- title
- description
- acceptance criteria
- importance
- staleness or neglect signal
- action type
- assignment state
- activity state
- agent-readiness fields
- timestamps

## Action Types

Initial action types:

- research
- plan
- execute
- test
- check
- review

These are coarse task intents. They should guide routing and validation without
pretending every agent workflow is identical.

## Importance And Neglect

Task importance and project importance combine in future prioritisation.

The first model only records coarse task importance and neglect state. It does
not implement scoring, decay, ranking, or scheduling.

Unknown scoring policy must not leak into arbitrary numeric fields before the
prioritisation contract exists.

## Assignment State

A task may be:

- unassigned
- assigned to a human
- assigned to an agent
- mixed across more than one actor

Assignment state does not mean execution has started. Activity state records
whether the task is proposed, ready, active, blocked, done, or archived.

## Agent Readiness

Agent-readiness fields must cover:

- whether the task is ready for agent delegation
- required context references
- allowed action types
- stop conditions
- validation commands

A task should not be one-click delegated unless the readiness fields are clear
enough for the selected agent and harness.

## Current Rust Surface

`nucleus-tasks` now contains the first draft of:

- `TaskId`
- `Task`
- `AcceptanceCriterion`
- `TaskImportance`
- `NeglectSignal`
- `NeglectLevel`
- `TaskActionType`
- `AssignmentState`
- `TaskActivityState`
- `AgentReadiness`
- `TaskTimestamps`

These are descriptive domain types only. Scheduling, scoring, assignment
execution, and agent delegation remain out of scope.

## Research Gaps

- Exact importance and staleness scoring policy.
- How task ranking combines project baseline, task importance, and inactivity.
- How validation commands bind to harness sessions and repo worktrees.
- How task history should record agent attempts, failures, and handoffs.

## Next Task

Draft adapter runtime ownership and stream semantics.
