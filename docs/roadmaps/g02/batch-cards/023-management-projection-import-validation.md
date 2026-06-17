# 023 Management Projection Import Validation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../007-management-projection-sync-foundation.md`

## Purpose

Add validation for repo-backed management projection records before any import
can mutate authoritative state.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Scope

- Add validation result records for:
  - valid
  - valid with warnings
  - invalid
  - unsupported schema
- Validate schema envelope fields, record kind, required ids, project refs, and
  excluded-state markers.
- Preserve unsupported or invalid records as validation evidence; do not drop
  them.
- Return staged validation output only. Do not import into live project/task
  state.

## Acceptance Criteria

- A fresh clone projection can be validated before import.
- Invalid records are reported with stable record/file refs.
- Unsupported schema records are preserved and reported.
- Validation does not apply mutations or overwrite local state.

## Validation

- focused validation tests covering valid, invalid, unsupported, and warning
  outcomes
- `cargo check --workspace`

## Stop Conditions

- Stop if validation starts resolving semantic conflicts.
- Stop if validation deletes, rewrites, or auto-migrates projection files.
- Stop if parser errors are exposed as the only normal user-facing result.

## Outcome

Added validation report vocabulary and envelope validation for valid, invalid,
and unsupported schema outcomes. Validation does not import or mutate state.
