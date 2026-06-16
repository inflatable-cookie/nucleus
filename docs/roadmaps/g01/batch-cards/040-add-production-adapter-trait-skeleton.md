# 040 Add Production Adapter Trait Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add production adapter trait skeleton.

## Scope

- Add Rust trait skeletons for static production adapter boundaries.
- Keep traits modular and split by SCM, forge, command authority, and
  observation source.
- Add only value-returning methods for identity, provider kind, capabilities,
  workflow semantics, readiness, and required command scopes.
- Do not implement real adapters.
- Do not add async, streaming, process execution, network, registry, or server
  orchestration.

## Out Of Scope

- Real Git, Convergence, forge, harness, or command execution.
- Runtime adapter registry integration.
- Async runtime or stream type selection.
- Webhook endpoint implementation.
- Persistence or replay storage.

## Evidence Questions

- Which existing type-only crates should own the first trait skeletons?
- Should command authority traits live in `nucleus-command-policy` or
  `nucleus-server` first?
- Which effectful methods must stay out until runtime contracts are drafted?

## Stop Conditions

- The skeleton introduces async, streaming, or process execution.
- Traits copy dev-only fixture APIs directly.
- Traits assume all SCM providers use commits, branches, and pull requests.
- Adapters can bypass server-owned command authority.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Added static trait skeletons to `nucleus-scm-forge` for SCM adapters, forge
  adapters, and observation sources.
- Added static command authority policy trait skeleton to
  `nucleus-command-policy`.
- Added only value-returning methods for identity, capabilities, workflow
  semantics, readiness, command scopes, refresh modes, sandbox defaults, and
  approval policy.
- Kept async, streams, execution, network, registry integration, persistence,
  and provider implementations out of scope.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
