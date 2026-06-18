# 168 Management Sync Hardening Validation

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../037-repo-backed-management-sync-hardening.md`

## Purpose

Validate repo-backed management sync hardening and choose the next lane.

## Scope

- Run docs, Rust, desktop, and targeted management projection gates.
- Record residual risk.
- Set the next ready card or operator gate.

## Acceptance Criteria

- Projection authority is clear enough for implementation to continue.
- Export/import/conflict behavior is tested.
- Next lane does not reopen parallel work.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo test -p nucleus-engine management_sync`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if validation shows committable state policy is wrong.
