# 006 Product Workflow Planning Context Composition

Status: completed
Owner: Tom
Updated: 2026-07-06
Milestone: `../002-product-workflow-source-composition.md`

## Purpose

Feed existing planning session and task seed records into the product workflow
summary.

## Work

- [x] Locate existing server-side planning session and task seed projection
  helpers.
- [x] Summarize counts and sanitized refs in `planning_context`.
- [x] Remove the planning gap only when source records exist.
- [x] Preserve invalid, missing, or unsupported planning records as explicit
  gaps.
- [x] Add focused server/query/CLI tests for seeded and empty planning sources.

## Acceptance Criteria

- [x] Planning records make the workflow planning band useful without raw
  payloads.
- [x] Empty projects still report an honest planning gap.
- [x] No task promotion, planning import/apply, projection write, provider
  execution, SCM mutation, or UI mutation is introduced.

## Result

The product workflow query now composes existing planning session and planning
task seed projections into `planning_context`.

Bootstrap inspection now reports `planning_sessions=1`, `task_seeds=1`, and no
planning gap. Empty projects still report the planning gap.

## Validation

Passed:

- `cargo fmt --all --check`
- `cargo test -p nucleus-server product_workflow_summary -- --nocapture`
- `cargo test -p nucleus-server product_workflow -- --nocapture`
- `cargo test -p nucleusd product_workflow -- --nocapture`
- `cargo test -p nucleusd planning_product -- --nocapture`
- `cargo test -p nucleus-desktop product_workflow -- --nocapture`
- `effigy server:query:product-workflow-summary`
