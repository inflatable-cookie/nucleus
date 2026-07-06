# 002 Product Workflow Source Composition

Status: ready
Owner: Tom
Updated: 2026-07-06

## Purpose

Deepen the product workflow summary by composing existing server-owned,
read-only source projections into the single workflow view.

The first g04 slice proved the shape. This lane makes the shape more useful by
removing gaps when Nucleus already has planning, memory, research, runtime,
review, SCM, or next-step evidence.

## Governing Refs

- `docs/roadmaps/g04/001-product-workflow-rebaseline-and-vertical-slice.md`
- `docs/roadmaps/deferred-lanes.md`
- `docs/architecture/task-project-workflow-gap-matrix.md`
- `docs/architecture/server-client-gap-matrix.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/025-goal-loop-next-task-contract.md`

## Goals

- [ ] Compose planning sessions, task seeds, and accepted planning refs into
  the workflow summary.
- [ ] Compose memory proposal, accepted-memory, and research brief refs into
  the context band.
- [ ] Compose runtime evidence, command evidence, and review refs where those
  records already exist.
- [ ] Compose SCM readiness and next-step source records without performing SCM
  or task mutations.
- [ ] Keep query, DTO, CLI, Effigy, and desktop surfaces read-only and
  shape-stable.
- [ ] Keep deferred lanes deferred unless source composition proves a product
  blocker.

## Execution Plan

- [ ] Batch 1: planning context source composition.
- [ ] Batch 2: memory and research context composition.
- [ ] Batch 3: runtime and review source composition.
- [ ] Batch 4: SCM readiness and next-step composition.
- [ ] Batch 5: validation and next lane selection.

## Batch Cards

Ready cards:

- `batch-cards/006-product-workflow-planning-context-composition.md`

Planned cards:

- `batch-cards/007-product-workflow-memory-research-composition.md`
- `batch-cards/008-product-workflow-runtime-review-composition.md`
- `batch-cards/009-product-workflow-scm-next-composition.md`
- `batch-cards/010-product-workflow-source-composition-validation.md`

Completed cards:

No completed cards yet.

## Boundary

This lane may:

- summarize existing planning sessions, task seeds, accepted planning refs,
  memory proposals, accepted memory records, research briefs, runtime evidence,
  review records, SCM readiness records, and known next-step sources
- add read-only query composition helpers and focused tests
- extend display text for existing workflow bands when the DTO shape already
  supports it

This lane must not:

- mutate tasks, project state, memory, planning artifacts, SCM, forge, provider,
  or UI state
- apply imports or accepted-memory records
- write projection files
- execute providers or SCM commands
- start final UI, plugin runtime, editor, panel-layout, or design-system work
- invent workflow state when a source record does not exist

## Acceptance Criteria

- [ ] Existing planning records remove the planning gap.
- [ ] Existing memory or research records remove the context gap.
- [ ] Existing runtime or review records remove the relevant runtime/review
  gaps.
- [ ] Existing SCM or next-step records remove the relevant SCM/next gaps.
- [ ] Missing sources remain explicit gaps.
- [ ] The disposable product workflow proof continues to consume the server
  summary without client authority.
