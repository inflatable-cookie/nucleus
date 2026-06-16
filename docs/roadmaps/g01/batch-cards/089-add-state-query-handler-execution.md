# 089 Add State Query Handler Execution

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Execute read-only state queries through the local request handler.

## Scope

- Route project, task, workspace, adapter/session, model route, and runtime
  metadata queries to server-owned services.
- Return state record sets.
- Preserve transport independence.
- Keep queries read-only.

## Out Of Scope

- State mutation commands.
- Live subscriptions.
- Network transport.
- Tauri IPC.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/008-local-request-handling-and-transport-readiness.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Read-only query execution lives in `request_handler.rs`.
- Project, task, and workspace state queries support direct `Get` and `List`
  through `ServerStateService`.
- Adapter/session queries support adapter and session direct get/list paths.
- Model route queries support direct get/list paths.
- Runtime metadata queries support stored effect get plus command evidence and
  artifact metadata lists.
- Indexed filters and runtime ref resolution are explicit unsupported paths
  until repository indexes exist.

## Closeout

The local handler now executes read-only state queries and returns typed query
results. Tests cover project list queries, adapter/session and runtime metadata
queries, unsupported indexed filters, command receipt deferral, and auth
readiness denial.

No state mutation, command execution, network transport, Tauri IPC, live
subscription, provider adapter, or runtime worker behavior was added.
