# 022 Selected Task Aggregate Product Shell Placement

Status: superseded
Owner: Tom
Updated: 2026-07-09

## Purpose

Attempted to place the selected-task product aggregate in the normal product
shell.

This direction was rolled back. The workspace must remain empty until the
higher-level product workflow is designed with operator guidance.

## Governing Refs

- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g04/020-selected-task-product-aggregate-query.md`

## Goals

- [x] Add a product-shell aggregate placement boundary.
- [x] Show selected-task aggregate state in the workspace stage.
- [x] Keep proof harness isolated behind its launcher.
- [x] Keep all selected-task aggregate shell behavior read-only.
- [x] Validate the product shell path and select the next UI/workflow lane.

## Execution Plan

- [x] Batch 1: product-shell aggregate placement boundary.
- [x] Batch 2: read-only workspace-stage aggregate panel.
- [x] Batch 3: loading, empty, and fallback states.
- [x] Batch 4: validation and next-lane selection.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Superseded cards:

- `batch-cards/107-selected-task-aggregate-shell-placement-boundary.md`
- `batch-cards/108-selected-task-aggregate-workspace-panel.md`
- `batch-cards/109-selected-task-aggregate-shell-state-hardening.md`
- `batch-cards/110-selected-task-aggregate-shell-validation-next-lane.md`

## Boundary

This lane may:

- add product-shell client state for loading the selected-task aggregate
- add a read-only selected-task aggregate panel in the central workspace stage
- show next action, blockers, command preview counts, evidence, review, rework,
  completion, SCM handoff, and source health at a summary level
- add loading, empty, error, and unsupported states

This lane must not:

- add task mutation controls
- schedule delegation
- execute providers, SCM, terminal, browser, editor, or forge actions
- move proof modal widgets into the normal shell
- commit to final visual design beyond the current conservative shell layout

## Decision Notes

The aggregate still exists as a server/client read model, but it should not be
rendered in the normal workspace until the higher-level workflow design says
where task state belongs.

Cards 107-110 placed the selected-task aggregate in the normal workspace stage
as a read-only summary with local loading, empty, unsupported, and error states.
That UI was removed after operator correction because it put task detail on
screen before the workflow shape was designed. The normal workspace is blank
again; proof diagnostics remain behind the proof harness.
