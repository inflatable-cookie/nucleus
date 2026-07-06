# 008 Product Workflow Runtime Review Composition

Status: planned
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing runtime, command evidence, task progress, and review records into
the product workflow summary.

## Work

- [ ] Locate existing runtime receipt, command evidence, task work progress,
  and review source records.
- [ ] Summarize counts, statuses, and refs in `runtime` and `review`.
- [ ] Remove runtime or review gaps only where source records exist.
- [ ] Keep provider live-read expansion, callbacks, cancellation, and agent
  scheduling out of scope.
- [ ] Add focused tests for populated and empty runtime/review sources.

## Acceptance Criteria

- [ ] Runtime and review bands reflect available evidence without raw payloads.
- [ ] Missing evidence remains explicit.
- [ ] No provider execution or task mutation is introduced.
