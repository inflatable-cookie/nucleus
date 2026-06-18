# 036 Task Backed Workflow Validation And Next Lane

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Validate the task-backed agent workflow proof and choose the next workflow
lane.

## Governing Refs

- `docs/logs/2026-06-18-stocktake.md`
- `docs/roadmaps/long-term-plan.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/018-orchestration-contract.md`

## Goals

- [ ] Prove the task-backed work-unit path through fixtures and control DTOs.
- [ ] Re-run health gates after module and runtime work.
- [ ] Promote any durable findings into architecture/contracts.
- [ ] Choose the next workflow: repo-backed management sync or native steward.

## Execution Plan

- [ ] Fixture batch: build a complete task work-unit proof fixture.
- [ ] Promotion batch: update architecture/contracts from implementation facts.
- [ ] Health batch: re-run doctor, Rust, desktop, and docs gates.
- [ ] Selection batch: choose the next workflow lane.
- [ ] Closeout batch: update roadmap pointers.

## Batch Cards

Planned cards:

- `batch-cards/159-task-backed-workflow-fixture-validation.md`
- `batch-cards/160-task-backed-findings-promotion.md`
- `batch-cards/161-post-runtime-health-gate.md`
- `batch-cards/162-next-workflow-lane-selection.md`
- `batch-cards/163-g02-task-backed-runway-closeout.md`

## Acceptance Criteria

- [ ] The task-backed workflow proof is inspectable and replayable.
- [ ] Doctor and QA status are recorded.
- [ ] The next lane is explicit and not parallelized.

## Gate

Stop if validation shows the workflow model needs another contract pass.
