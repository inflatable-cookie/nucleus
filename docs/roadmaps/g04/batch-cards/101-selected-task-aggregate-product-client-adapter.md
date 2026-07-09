# 101 Selected Task Aggregate Product Client Adapter

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../020-selected-task-product-aggregate-query.md`

## Purpose

Add a desktop product client adapter boundary for the selected-task aggregate,
separate from proof UI helpers.

## Work

- [x] Add TS request/response types for the aggregate.
- [x] Add client query helper outside proof-only modules.
- [x] Keep proof modal unchanged except where imports must stay compiling.
- [x] Add lightweight type/check coverage.

## Acceptance Criteria

- [x] Product shell work can consume one aggregate helper.
- [x] Proof helper pile does not become the product API.
- [x] No final UI visuals are implemented.

## Result

Added the product-facing selected-task aggregate TS types, response decoder,
query builder, and client helper without changing proof modal behavior.
