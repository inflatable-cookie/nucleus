# 191 Define First Local Sandbox Backend Slice

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first concrete local sandbox backend slice.

## Scope

- Pick the first enforceable sandbox profile.
- Name supported platforms and unsupported platforms.
- Define evidence refs the backend must produce.
- Keep enforcement separate from spawn.

## Out Of Scope

- Implementing process spawn.
- Full container orchestration.
- Remote execution.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-server`

## Acceptance Criteria

- First sandbox backend slice is narrow.
- Unsupported platforms have explicit discovery output.
- Spawn remains blocked without the other required backends.

## Closeout

- First enforced sandbox target is `NoFilesystemWrite`.
- Unsupported/advisory discovery remains the default until a platform backend
  can prove enforcement.
- Sandbox implementation must produce enforcement evidence refs and must not
  spawn processes itself.
