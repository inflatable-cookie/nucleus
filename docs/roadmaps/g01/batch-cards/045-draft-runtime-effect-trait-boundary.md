# 045 Draft Runtime Effect Trait Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft runtime effect trait boundary.

## Scope

- Draft the first contract language for SCM, forge, and command runtime effect
  traits.
- Separate effect request acceptance from runtime execution, observation
  return, sanitized command evidence, cancellation, timeout, and recovery.
- Keep SCM/forge effects behind server command authority for command-backed
  work.
- Identify which trait surfaces can be value-returning now and which require a
  later async/runtime decision.

## Out Of Scope

- Implementing Rust effect traits.
- Choosing async runtime, stream types, scheduler, process runner, PTY strategy,
  sandbox backend, webhook server, or artifact store.
- Provider-specific adapter behavior.
- Persistence, replay, polling workers, or real command execution.

## Evidence Questions

- Should effect acceptance and effect outcome reporting be one trait or two?
- Does cancellation need a separate status record before traits exist?
- Which effect outcomes need sanitized evidence versus normalized
  observations?
- Where should server-owned scheduling, retry, and timeout policy be named?

## Stop Conditions

- The draft starts implementing runtime behavior.
- The draft lets adapters mutate project, task, workspace, projection, or
  history state directly.
- The draft lets adapters bypass command authority.
- The draft hard-codes Git-only, GitHub-only, or process-runner-specific
  assumptions.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
