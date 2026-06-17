# 024 Management Projection Conflict Reporting

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../007-management-projection-sync-foundation.md`

## Purpose

Separate schema validation problems from semantic project/task conflicts so
later sync work can present repairable issues instead of raw Git conflict text.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Scope

- Add first conflict report vocabulary for management projection validation.
- Distinguish schema conflicts from semantic conflicts.
- Name initial semantic conflict classes:
  - project identity mismatch
  - repo membership meaning change
  - task deletion versus update
  - incompatible task status
  - acceptance criteria rewrite
  - assignment intent mismatch
  - meaningful history rewrite
- Link conflicts to projection file refs and local authoritative record refs
  where available.
- Keep mechanical Git conflict resolution and forge review workflows out of
  scope.

## Acceptance Criteria

- Validation can report schema and semantic conflict classes separately.
- Conflict reports are sanitized and contain no secret/provider/runtime
  payloads.
- The milestone leaves SCM adapter mutation for
  `008-scm-forge-driver-runway.md`.
- g02/007 can close with export, validation, and conflict vocabulary in place.

## Validation

- focused conflict-report tests
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if conflict reporting starts doing SCM merge resolution.
- Stop if reports rely on Git-only object vocabulary.
- Stop if semantic conflicts are auto-resolved without task/project domain
  commands.

## Outcome

Added schema and semantic conflict report vocabulary. Reports stay
SCM-neutral and do not perform merge resolution.
