# 471 Task Seed Promotion CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Expose promotion diagnostics through `nucleusd` and Effigy.

## Work

- [x] Add `nucleusd query` rendering for promotion diagnostics.
- [x] Add root Effigy selector.
- [x] Keep command execution surfaces separate from diagnostics.

## Acceptance Criteria

- [x] Effigy selector is read-only.
- [x] Output is line-oriented and sanitized.
- [x] No provider, SCM, or task mutation occurs from the query.

## Result

- Added `nucleusd query task-seed-promotion-diagnostics --project <project-id>`.
- Added `effigy server:query:task-seed-promotion-diagnostics`.
- Output is line-oriented and reports read-only/no-effect flags.
