# 100 Split Request Handler Module Boundaries

Status: planned
Owner: Tom
Updated: 2026-06-16

## Goal

Split `LocalControlRequestHandler` code into focused modules without changing
behavior.

## Scope

- Separate handler boundary types from handler implementation.
- Separate query handling from command receipt handling.
- Keep tests close to the behavior they prove.
- Preserve public exports from `nucleus-server::lib`.

## Out Of Scope

- New command execution.
- State mutation handling.
- Transport implementation.
- Scheduler behavior changes.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/010-server-module-decomposition-and-ipc-readiness.md`

## Acceptance Criteria

- Request handler modules are smaller and named by responsibility.
- Existing request handler tests still pass.
- Public handler exports remain stable.
- No command, query, auth, replay, or scheduler semantics change.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```
