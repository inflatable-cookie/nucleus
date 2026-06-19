# 047 SCM Work Sessions Module Split

Status: planned
Owner: Tom
Updated: 2026-06-19

## Purpose

Split `crates/nucleus-scm-forge/src/work_sessions.rs` into focused type modules
without changing public behavior.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/implementation-audit.md`

## Goals

- [ ] Separate session plans, guard checks, cleanup policy, and recovery
      records.
- [ ] Preserve public re-exports.
- [ ] Keep SCM tests green.

## Execution Plan

- [ ] Type batch: split policy/session type groups.
- [ ] Recovery batch: split cleanup and recovery records.
- [ ] Validation batch: run scoped SCM tests and workspace check.

## Batch Cards

Ready cards:

- None.

Planned cards:

- `batch-cards/211-scm-work-session-policy-type-split.md`
- `batch-cards/212-scm-work-session-recovery-type-split.md`
- `batch-cards/213-scm-work-session-validation.md`

Completed cards:

- None.

## Acceptance Criteria

- [ ] `work_sessions.rs` becomes a module front door.
- [ ] Public API remains available through `nucleus-scm-forge`.
- [ ] No provider execution behavior is added.

## Gate

This is a mechanical split only.
