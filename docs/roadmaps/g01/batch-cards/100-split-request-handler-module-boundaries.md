# 100 Split Request Handler Module Boundaries

Status: done
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

## Decisions

- `request_handler/mod.rs` is now the module index.
- The boundary marker lives in `request_handler/boundary.rs`.
- The core handler, auth gate, and service accessors live in
  `request_handler/handler.rs`.
- Command receipt handling lives in `request_handler/commands.rs`.
- Query execution lives in `request_handler/queries.rs`.
- Request handler tests live in `request_handler/tests.rs`.

## Closeout

Split request handler code into focused modules without changing public exports,
auth handling, query behavior, command receipts, scheduler admission behavior,
or state access.
