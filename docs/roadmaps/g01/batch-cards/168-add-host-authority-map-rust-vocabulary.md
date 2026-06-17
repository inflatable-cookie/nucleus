# 168 Add Host Authority Map Rust Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add first Rust types for engine host identity, host forms, authority domains,
and project authority assignments.

## Scope

- Add host id and host form vocabulary.
- Add authority domain vocabulary.
- Add project authority assignment/map records.
- Keep types descriptive and compile-only.

## Out Of Scope

- Persistence.
- Remote protocol.
- Host registry implementation.
- Runtime process spawning.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/017-engine-host-authority-contract.md`

## Acceptance Criteria

- Types compile.
- Tests prove host connection and project authority are distinct.
- Remote worker can have execution authority without source/task authority.

## Closeout

- Added host authority vocabulary to `nucleus-server`.
- Tests prove a remote worker can own execution authority without source or
  task authority.
