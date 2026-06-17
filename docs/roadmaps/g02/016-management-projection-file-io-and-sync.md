# 016 Management Projection File IO And Sync

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Move repo-backed project-management projections from in-memory plans to
explicit file IO and sync preparation.

This is the next step toward committable tasks, accepted planning artifacts,
accepted memory, and accepted research synthesis.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/015-deep-research-contract.md`
- `docs/roadmaps/g02/007-management-projection-sync-foundation.md`

## Goals

- [x] Serialize and parse management projection files with schema envelopes.
- [x] Write projection files through policy-gated filesystem effects.
- [x] Stage imports without silently mutating authoritative records.
- [x] Surface schema, semantic, and SCM sync conflicts separately.
- [x] Keep local layout, runtime streams, secrets, caches, and provider state
  excluded by default.

## Execution Plan

- [x] File format batch: choose and implement first TOML envelope codecs.
- [x] Export IO batch: write minimal project/task projection files.
- [x] Import staging batch: parse and validate fresh-clone projection files.
- [x] Conflict batch: surface conflicts for steward or operator resolution.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/058-management-projection-file-format-codec.md`
- `batch-cards/059-management-projection-export-file-io.md`
- `batch-cards/060-management-projection-import-staging.md`
- `batch-cards/061-management-projection-sync-conflict-surface.md`

## Acceptance Criteria

- [x] One project can export management projection files to a repo path.
- [x] Another clone can parse and validate those files before import.
- [x] Unsupported records survive round trip as explicit unsupported records.
- [x] No runtime/local-only state is written into committable projection files.

## Gate

Do not automate SCM push/pull for management files until file IO, validation,
and conflict reporting are reliable.
