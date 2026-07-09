# 097 Selected Task Aggregate Contract

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../020-selected-task-product-aggregate-query.md`

## Purpose

Define the product-facing selected-task aggregate contract before composing
server code.

## Work

- [x] Inventory existing selected-task proof query outputs.
- [x] Define aggregate field groups for product UI consumption.
- [x] Classify included, summarized, and diagnostic-only fields.
- [x] Identify source queries and refs for each group.
- [x] Record stop conditions for mutation/provider/SCM behavior.

## Acceptance Criteria

- [x] The aggregate is read-only and product-shaped.
- [x] The proof modal remains diagnostic-only.
- [x] Server implementation can proceed without inventing UI fields.

## Result

The durable rule now lives in
`docs/contracts/023-task-backed-agent-workflow-contract.md`.

The architecture note in
`docs/architecture/product-workflow-ui-architecture.md` records the product
shape and keeps proof-query detail out of the normal shell.
