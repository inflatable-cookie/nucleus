# 030 Task Backed Agent Workflow Contract Reset

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Tighten the task-backed agent workflow rules before turning the proof records
into a runtime path.

## Governing Refs

- `docs/contracts/005-task-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/021-checkpoint-diff-contract.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Goals

- [x] Define the task-backed work-unit lifecycle.
- [x] Name admission, wait, running, review, accepted, failed, and canceled
  states.
- [x] Clarify how Codex runtime events bind to task work units without making
  Codex the universal abstraction.
- [x] Keep SCM mutation and final UI design out of this runway.

## Execution Plan

- [x] Lifecycle batch: promote task-backed work-unit state rules.
- [x] Runtime binding batch: define Codex-specific binding and generic adapter
  expectations.
- [x] Review batch: define checkpoint/review acceptance boundaries.
- [x] Validation batch: update docs indexes and planned code gates.

## Batch Cards

Completed cards:

- `batch-cards/129-task-backed-workflow-lifecycle-contract.md`
- `batch-cards/130-task-work-unit-state-gap-review.md`
- `batch-cards/131-codex-task-runtime-binding-contract.md`
- `batch-cards/132-task-work-review-acceptance-contract.md`
- `batch-cards/133-task-backed-contract-validation.md`

## Acceptance Criteria

- [x] Runtime code can be implemented without inventing workflow states.
- [x] Codex-specific behavior is isolated behind adapter/runtime binding rules.
- [x] Human review and acceptance are explicit before state is marked complete.

## Result

Added `docs/contracts/023-task-backed-agent-workflow-contract.md` and linked it
from task, timeline, receipt, checkpoint/diff, and contract index surfaces.

## Gate

Do not implement runtime admission until this contract reset is complete.
