# 471 Task Seed Promotion CLI Effigy

Status: planned
Owner: Tom
Updated: 2026-06-23
Milestone: `../113-task-seed-promotion-command.md`

## Purpose

Expose promotion diagnostics through `nucleusd` and Effigy.

## Work

- [ ] Add `nucleusd query` rendering for promotion diagnostics.
- [ ] Add root Effigy selector.
- [ ] Keep command execution surfaces separate from diagnostics.

## Acceptance Criteria

- [ ] Effigy selector is read-only.
- [ ] Output is line-oriented and sanitized.
- [ ] No provider, SCM, or task mutation occurs from the query.
