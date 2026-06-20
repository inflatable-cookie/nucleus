# 082 Task Backed Live Workflow Closeout

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Close the task-backed live Codex workflow as a reusable product proof and pick
the next lane deliberately.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/long-term-plan.md`

## Goals

- [x] Add an end-to-end task-backed live workflow fixture.
- [x] Add a stopped-by-default `nucleusd` durable runtime smoke dry-run.
- [x] Add authority regression coverage across provider/task/review/SCM gates.
- [x] Update gap indexes from actual runtime evidence.
- [x] Select the next product lane.

## Execution Plan

- [x] Workflow fixture batch.
- [x] Smoke dry-run batch.
- [x] Authority regression batch.
- [x] Gap closeout batch.
- [x] Next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/374-task-backed-live-workflow-fixture.md`
- `batch-cards/375-nucleusd-durable-runtime-smoke-dry-run.md`
- `batch-cards/376-live-workflow-authority-regression-suite.md`
- `batch-cards/377-live-workflow-gap-index-closeout.md`
- `batch-cards/378-next-product-lane-selection.md`

## Acceptance Criteria

- [x] The task-backed live workflow is replayable as a fixture.
- [x] Smoke dry-run remains stopped by default.
- [x] Authority regressions fail closed.
- [x] The next product lane is selected from evidence, not convenience.
