# 036 Task Backed Workflow Validation And Next Lane

Status: completed
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

- [x] Prove the task-backed work-unit path through fixtures and control DTOs.
- [x] Re-run health gates after module and runtime work.
- [x] Promote any durable findings into architecture/contracts.
- [x] Choose the next workflow: repo-backed management sync or native steward.

## Execution Plan

- [x] Fixture batch: build a complete task work-unit proof fixture.
- [x] Promotion batch: update architecture/contracts from implementation facts.
- [x] Health batch: re-run doctor, Rust, desktop, and docs gates.
- [x] Selection batch: choose the next workflow lane.
- [x] Closeout batch: update roadmap pointers.

## Batch Cards

Completed cards:

- `batch-cards/159-task-backed-workflow-fixture-validation.md`
- `batch-cards/160-task-backed-findings-promotion.md`
- `batch-cards/161-post-runtime-health-gate.md`
- `batch-cards/162-next-workflow-lane-selection.md`
- `batch-cards/163-g02-task-backed-runway-closeout.md`

## Acceptance Criteria

- [x] The task-backed workflow proof is inspectable and replayable.
- [x] Doctor and QA status are recorded.
- [x] The next lane is explicit and not parallelized.

## Gate

Stop if validation shows the workflow model needs another contract pass.

## Result

- Task-backed workflow fixture validation passed without provider execution or
  SCM mutation.
- Durable findings were promoted into the task-backed workflow contract and
  implementation gap index.
- Health gate passed except for the known `effigy doctor` `scan.god-files`
  failure: 36 findings, 35 warnings, 1 error.
- Next workflow lane selected: repo-backed management sync hardening.
