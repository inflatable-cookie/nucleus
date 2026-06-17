# 084 Management Sync Plan Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../021-management-projection-sync-runtime.md`

## Purpose

Represent projection export, import, and sync work as durable engine plans.

## Scope

- Add sync plan records for export, import, validate, repair, and capture prep.
- Link plans to projection file refs and runtime receipts.
- Keep provider mutation out of scope.

## Acceptance Criteria

- Sync plans can represent export and import intent separately.
- Plans can cite projection file refs and receipts.
- Plans cannot imply commit, push, or publication.

## Validation

- `cargo test -p nucleus-engine management_projection`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if provider mutation is required.
