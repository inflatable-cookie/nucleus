# 116 Sync Diagnostics Source Records

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../027-diagnostics-read-model-source-integration.md`

## Purpose

Source management sync diagnostics from available engine/server records.

## Scope

- Read available projection sync plans, repairs, routes, and capture preps.
- Return explicit empty state when absent.
- Do not run SCM or provider mutation.

## Acceptance Criteria

- Sync diagnostics use available source records.
- Empty state is explicit.
- Query execution cannot commit, push, publish, or capture.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if source integration requires provider mutation.
