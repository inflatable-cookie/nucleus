# 016 Management Projection File IO And Sync

Status: planned
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

- [ ] Serialize and parse management projection files with schema envelopes.
- [ ] Write projection files through policy-gated filesystem effects.
- [ ] Stage imports without silently mutating authoritative records.
- [ ] Surface schema, semantic, and SCM sync conflicts separately.
- [ ] Keep local layout, runtime streams, secrets, caches, and provider state
  excluded by default.

## Execution Plan

- [ ] File format batch: choose and implement first TOML/JSON envelope codecs.
- [ ] Export IO batch: write minimal project/task projection files.
- [ ] Import staging batch: parse and validate fresh-clone projection files.
- [ ] Conflict batch: surface conflicts for steward or operator resolution.

## Acceptance Criteria

- [ ] One project can export management projection files to a repo path.
- [ ] Another clone can parse and validate those files before import.
- [ ] Unsupported records survive round trip as explicit unsupported records.
- [ ] No runtime/local-only state is written into committable projection files.

## Gate

Do not automate SCM push/pull for management files until file IO, validation,
and conflict reporting are reliable.

