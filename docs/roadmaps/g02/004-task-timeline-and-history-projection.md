# 004 Task Timeline And History Projection

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Add the first durable task timeline projection after task command mutation is
owned by the engine.

This milestone connects task state, command admission events, task history, and
future agent session timeline entities without starting provider runtime work.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/architecture-gap-index.md`

## Goals

- [x] Define the first task timeline read model.
- [x] Link task command events to task history entries.
- [x] Preserve stable ids for task, command, event, activity, and future
  session refs.
- [x] Add deterministic projection rebuild tests.
- [x] Keep provider messages and runtime streams out of scope.

## Execution Plan

- [x] Projection shape batch: define task timeline records and provenance.
- [x] Event mapping batch: map task command-admitted and task-state events into
  timeline entries.
- [x] Query batch: expose a read-only task timeline query through host APIs.
- [x] Validation batch: prove deterministic rebuild and close the milestone.

## Acceptance Criteria

- [x] One task timeline can be rebuilt from orchestration/task event records.
- [x] Timeline entries expose provenance without copying raw runtime payloads.
- [x] Clients can query the timeline read model through the server proof API.
- [x] Existing task list/detail behavior remains intact.

## Gate

Do not start until `003-engine-task-command-boundary.md` is complete.

## Outcome

- Added `EngineTaskTimelineProjection` and task timeline entry vocabulary in
  `nucleus-engine`.
- Projected task-family command-admitted events into deterministic task-scoped
  timeline entries when the event target is a concrete task id.
- Added a read-only `TaskTimelineQuery` and `TaskTimeline` query result through
  the server proof API.
- Added compact control response DTOs for task timeline entries.
- Preserved existing task command and task query behavior.
- Deferred project-targeted task creation events until a later task-state event
  can link creation to the created task id.
