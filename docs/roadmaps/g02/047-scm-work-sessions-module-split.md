# 047 SCM Work Sessions Module Split

Status: completed
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-scm-forge/src/work_sessions.rs` into focused type modules
without changing public behavior.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [x] Separate session plans, guard checks, cleanup policy, and recovery
      records.
- [x] Preserve public re-exports.
- [x] Keep SCM tests green.

## Execution Plan

- [x] Type batch: split policy/session type groups.
- [x] Recovery batch: split cleanup and recovery records.
- [x] Validation batch: run scoped SCM tests and workspace check.

## Batch Cards

Ready cards:

- None.

Planned cards:

- None.

Completed cards:

- `batch-cards/211-scm-work-session-policy-type-split.md`
- `batch-cards/212-scm-work-session-recovery-type-split.md`
- `batch-cards/213-scm-work-session-validation.md`

## Acceptance Criteria

- [x] `work_sessions.rs` becomes a module front door.
- [x] Public API remains available through `nucleus-scm-forge`.
- [x] No provider execution behavior is added.

## Result

`work_sessions.rs` is now a module front door with session plan, execution
prep, recovery, and test modules. Scoped SCM tests and workspace check pass.

## Gate

This is a mechanical split only.
