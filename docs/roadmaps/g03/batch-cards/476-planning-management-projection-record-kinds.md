# 476 Planning Management Projection Record Kinds

Status: completed
Owner: Tom
Updated: 2026-06-24
Milestone: `../114-planning-management-projection-payloads.md`

## Purpose

Add projection record-kind coverage for planning artifacts and planning task
seeds.

## Work

- [x] Add planning task seed record kind where needed.
- [x] Keep planning artifact and task seed kinds distinct.
- [x] Add tests for kind encode/decode.

## Acceptance Criteria

- [x] Planning task seeds are not encoded as `Task`.
- [x] Unknown or mismatched kinds fail deterministically.
