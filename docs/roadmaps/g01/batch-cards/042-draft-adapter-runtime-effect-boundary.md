# 042 Draft Adapter Runtime Effect Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft adapter runtime effect boundary.

## Scope

- Draft docs for effectful adapter runtime boundaries.
- Separate static trait surfaces from refresh, polling, webhook handling,
  command-backed actions, cancellation, and event streaming.
- Keep command execution server-owned.
- Identify which effects require async or streaming decisions later.
- Keep implementation out of scope.

## Out Of Scope

- Rust async traits.
- Runtime implementation.
- Provider adapters.
- Command execution.
- Network clients.
- Persistence and replay.

## Evidence Questions

- Which effect categories should be first-class: refresh, subscribe, command
  request, webhook input, cancellation, recovery?
- Should effect results emit observations directly or return batches for server
  normalization?
- How should cancellation and retries be described without selecting runtime
  primitives?

## Stop Conditions

- The draft selects an async runtime or stream crate.
- The draft lets adapters mutate project/task/workspace state directly.
- The draft lets adapters execute commands without server command authority.
- The draft assumes Git-like workflows for all SCM providers.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Separated static adapter traits from effectful runtime work.
- Named initial effect categories for SCM, forge, and command authority.
- Kept command execution server-owned.
- Required effectful adapters to return observations, evidence, task-link
  proposals, conflicts, review refs, or command authority requests for server
  handling.
- Deferred async runtime, stream type, cancellation primitive, retry scheduler,
  replay store, transport, registry integration, PTY strategy, and sandbox
  implementation.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
