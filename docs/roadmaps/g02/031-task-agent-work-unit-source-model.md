# 031 Task Agent Work Unit Source Model

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Move task-backed agent work units from proof records toward server-owned source
records and projections.

## Governing Refs

- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/roadmaps/g02/015-task-backed-agent-work-unit-proof.md`

## Goals

- [x] Define source records for task work units.
- [x] Bind task delegation commands to work-unit admission records.
- [x] Project work-unit state into diagnostics/read models.
- [x] Keep provider runtime execution deferred.

## Execution Plan

- [x] Source record batch: add task work-unit source record types.
- [x] Admission batch: connect task delegation to work-unit admission.
- [x] Projection batch: rebuild work-unit state from source records/events.
- [x] Diagnostics batch: expose work-unit state through server read models.
- [x] Validation batch: prove no provider process starts.

## Batch Cards

Completed cards:

- `batch-cards/134-task-work-unit-source-records.md`
- `batch-cards/135-task-delegation-work-unit-admission.md`
- `batch-cards/136-task-work-unit-state-projection.md`
- `batch-cards/137-task-work-unit-diagnostics-read-model.md`
- `batch-cards/138-task-work-unit-source-validation.md`

## Acceptance Criteria

- [x] Task delegation creates or references a stable work unit.
- [x] Work-unit state is rebuildable.
- [x] Diagnostics can show work units without provider execution.

## Result

Task-agent work-unit source records, admission records, deterministic
projection, diagnostics, control DTO support, and desktop DTO types are in
place without provider process launch.

## Gate

Do not bind to Codex runtime until source records and projections are stable.
