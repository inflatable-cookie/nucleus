# 100 Selected Task Aggregate CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../020-selected-task-product-aggregate-query.md`

## Purpose

Add `nucleusd` and Effigy inspection for the selected-task aggregate.

## Work

- [x] Add `nucleusd query selected-task-product-aggregate`.
- [x] Add CLI rendering tests.
- [x] Add Effigy selector.
- [x] Keep output concise and product-shaped.

## Acceptance Criteria

- [x] Operator can inspect the aggregate from repo root.
- [x] CLI output avoids raw proof payload dumps.
- [x] Effigy selector is documented by `effigy tasks`.

## Result

Added the `nucleusd` query parser, typed product renderer, focused CLI tests,
and `server:query:selected-task-product-aggregate` Effigy selector.
