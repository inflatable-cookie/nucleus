# 015 Task-Backed Agent Work Unit Proof

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Prove the first product workflow that makes Nucleus more than a harness shell:
a task-backed unit of agentic work with durable timeline, receipts,
checkpoints, and reviewable outcome.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Create a work-item record that links task, agent session, turn timeline,
  receipts, and checkpoints.
- [x] Admit a task delegation command through the engine.
- [x] Run one bounded agent turn against that work item.
- [x] Project a task timeline summary from runtime events and receipts.
- [x] Preserve review and acceptance state separately from provider completion.

## Execution Plan

- [x] Work-item model batch: define records and task links.
- [x] Delegation command batch: admit task-to-agent work through orchestration.
- [x] Runtime linkage batch: connect agent session events to task timeline.
- [x] Review batch: represent completion, validation, and operator acceptance.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/054-task-agent-work-item-record-shape.md`
- `batch-cards/055-task-delegation-command-admission.md`
- `batch-cards/056-work-item-runtime-linkage-projection.md`
- `batch-cards/057-work-item-review-acceptance-boundary.md`

## Acceptance Criteria

- [x] A task can own one or more work items.
- [x] A work item can point to provider session, turns, receipts, and
  checkpoints without copying raw transcript streams.
- [x] Agent completion does not automatically mark task acceptance.
- [x] Replay rebuilds the task work timeline deterministically.

## Gate

Do not add broad autonomous task execution until one operator-controlled work
unit is reliable and replayable.
