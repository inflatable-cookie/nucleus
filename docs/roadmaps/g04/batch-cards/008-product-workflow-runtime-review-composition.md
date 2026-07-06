# 008 Product Workflow Runtime Review Composition

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing runtime, command evidence, task progress, and review records into
the product workflow summary.

## Work

- [x] Locate existing runtime receipt, command evidence, task work progress,
  and review source records.
- [x] Summarize counts, statuses, and refs in `runtime` and `review`.
- [x] Remove runtime or review gaps only where source records exist.
- [x] Keep provider live-read expansion, callbacks, cancellation, and agent
  scheduling out of scope.
- [x] Add focused tests for populated and empty runtime/review sources.

## Acceptance Criteria

- [x] Runtime and review bands reflect available evidence without raw payloads.
- [x] Missing evidence remains explicit.
- [x] No provider execution or task mutation is introduced.

## Result

The product workflow query now composes command evidence refs, runtime receipt
refs, task completion refs, and live-evidence review decision refs into the
`runtime` and `review` bands.

Task-scoped completion and review records are filtered through the project task
candidate set. Runtime receipts and command evidence remain evidence refs only;
the query does not expose raw payloads.

Provider live-read expansion, callbacks, cancellation, resume, scheduling, and
task mutation remain out of scope.

## Validation

Passed:

- `cargo fmt --all --check`
- `cargo test -p nucleus-server product_workflow_summary -- --nocapture`
- `cargo test -p nucleusd product_workflow -- --nocapture`
- `cargo test -p nucleus-desktop product_workflow -- --nocapture`
- `cargo check -p nucleus-server`
- `cargo check -p nucleusd`
- `cargo check -p nucleus-desktop`
