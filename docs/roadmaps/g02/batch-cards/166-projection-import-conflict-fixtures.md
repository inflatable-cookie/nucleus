# 166 Projection Import Conflict Fixtures

Status: planned
Owner: Tom
Updated: 2026-06-18
Milestone: `../037-repo-backed-management-sync-hardening.md`

## Purpose

Prove deterministic import staging and conflict reporting for repo-backed
management projection files.

## Scope

- Add or harden fixtures for valid import, schema mismatch, and divergent
  existing records.
- Preserve incoming records for repair review.
- Avoid silent overwrite.

## Acceptance Criteria

- Import staging is deterministic.
- Conflict records include enough refs for review.
- Repair proposals do not mutate provider/source files directly.

## Validation

- `cargo test -p nucleus-server management_projection`
- `cargo test -p nucleus-engine management_sync`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if conflict policy needs a new contract pass.
