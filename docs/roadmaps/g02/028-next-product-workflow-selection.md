# 028 Next Product Workflow Selection

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Choose the next product workflow after the diagnostics query runway.

The current G02 work has built command, runtime, projection, steward, SCM, and
diagnostics surfaces. The next implementation lane should prove one real
workflow instead of widening every subsystem at once.

## Governing Refs

- `docs/roadmaps/long-term-plan.md`
- `docs/roadmaps/reassessment-decision-queue.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/018-orchestration-contract.md`

## Goals

- [ ] Review current implementation state after diagnostics are queryable.
- [ ] Compare task-backed agent work, SCM management sync, and native steward
  workflow proofs.
- [ ] Pick one next runway.
- [ ] Compile follow-on roadmap/cards only after the choice is explicit.

## Execution Plan

- [ ] Options review batch: summarize viable workflow proofs.
- [ ] Task-backed agent batch: assess readiness and blockers.
- [ ] SCM management sync batch: assess readiness and blockers.
- [ ] Native steward batch: assess readiness and blockers.
- [ ] Selection batch: set the next ready runway or pause for operator choice.

## Batch Cards

Planned cards:

- `batch-cards/119-g02-product-workflow-options-review.md`
- `batch-cards/120-task-backed-agent-workflow-readiness-gate.md`
- `batch-cards/121-scm-management-sync-workflow-readiness-gate.md`
- `batch-cards/122-native-steward-workflow-readiness-gate.md`
- `batch-cards/123-next-runway-selection-and-closeout.md`

## Acceptance Criteria

- [ ] The next workflow is chosen with evidence.
- [ ] G02 does not split into parallel speculative lanes.
- [ ] Roadmap pointer is explicit at closeout.

## Gate

Stop for operator intent if the workflow choice is product-directional rather
than engineering-obvious.
