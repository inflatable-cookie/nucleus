# 021 Management Projection Schema Envelope

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../007-management-projection-sync-foundation.md`

## Purpose

Define the first repo-backed management projection schema envelope before any
export or import code writes shared files.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Scope

- Add a small, focused Rust module for management projection ids, file refs,
  schema versions, record kind, validation status, and envelope metadata.
- Represent the first projection root as `nucleus/`.
- Represent first-pass file paths for:
  - `nucleus/project.toml`
  - `nucleus/repos/<repo-membership-id>.toml`
  - `nucleus/tasks/<task-id>.toml`
  - `nucleus/indexes/README.md`
  - `nucleus/artifacts/README.md`
- Keep file parsing, TOML serialization, SCM operations, and import mutation
  out of scope for this card.

## Acceptance Criteria

- The schema envelope is provider-neutral and SCM-adapter neutral.
- Projection records distinguish shared project-management files from local
  client layout state.
- Projection envelopes can classify project, repo membership, task, index,
  artifact index, planning artifact, memory, research synthesis, and custom
  records without forcing all of them into the first export implementation.
- Unsupported schema and invalid record states are named before import exists.

## Validation

- `cargo test -p nucleus-engine management_projection`
- `cargo check --workspace`

## Stop Conditions

- Stop if the shape starts assuming Git commits, branches, or pull requests.
- Stop if local UI layout state is included in the shared projection model.
- Stop if first-pass schema work requires choosing TOML parser behavior.

## Outcome

Added `nucleus-engine` management projection root, file refs, schema version,
record kinds, envelopes, validation statuses, and excluded-state markers.
