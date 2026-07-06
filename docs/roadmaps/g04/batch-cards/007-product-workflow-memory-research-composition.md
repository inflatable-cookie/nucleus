# 007 Product Workflow Memory Research Composition

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing memory proposal, accepted-memory, and research brief records into
the product workflow context band.

## Work

- [x] Locate existing read-only memory proposal, accepted-memory, and research
  run brief sources.
- [x] Summarize counts, statuses, and sanitized refs in `context`.
- [x] Remove context gaps only for source categories with records.
- [x] Keep accepted-memory active apply and import apply out of scope.
- [x] Add focused tests for populated and empty context sources.

## Acceptance Criteria

- [x] Memory and research records improve the context band without applying or
  mutating anything.
- [x] Missing sources remain visible as gaps.
- [x] Accepted-memory active apply stays deferred.

## Result

The product workflow query now composes memory proposal refs, accepted-memory
refs, and research run refs into `context`.

Bootstrap inspection now reports `memory_proposals=1`, `research_runs=1`, and
no context gap. Empty projects still report the context gap.

Accepted-memory active apply remains out of scope; the composition only reads
sanitized refs.

## Validation

Passed:

- `cargo fmt --all --check`
- `cargo test -p nucleus-server product_workflow_summary -- --nocapture`
- `cargo test -p nucleusd product_workflow -- --nocapture`
- `cargo test -p nucleus-desktop product_workflow -- --nocapture`
- `effigy server:query:product-workflow-summary`
