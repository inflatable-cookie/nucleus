# 167 Management Sync Assistance Routing Proof

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../037-repo-backed-management-sync-hardening.md`

## Purpose

Route management projection conflicts into steward-assistable proposal records
without granting autonomous mutation authority.

## Scope

- Connect conflict reports to assistance routes.
- Keep proposals review-first.
- Preserve evidence refs for future steward UI/runtime work.

## Acceptance Criteria

- Assistance routes are deterministic from conflict input.
- No repair path mutates shared files without an admitted command.
- DTOs remain read-only where surfaced.

## Validation

- `cargo test -p nucleus-engine management_sync`
- `cargo test -p nucleus-server diagnostics`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if this becomes native steward runtime implementation.
