# 043 Add Adapter Runtime Effect Type Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add adapter runtime effect type skeleton.

## Scope

- Add type-only Rust vocabulary for adapter runtime effect requests and
  outcomes.
- Keep SCM/forge effects separate from command authority effects.
- Represent effect categories, cancellation, retry classification, and
  normalized observation batches.
- Avoid async, streams, process execution, network clients, persistence, and
  runtime registry integration.

## Out Of Scope

- Effect traits.
- Runtime implementation.
- Provider adapters.
- Command execution.
- Polling scheduler.
- Webhook transport.
- Replay or persistence.

## Evidence Questions

- Should effect request/outcome ids live in SCM/forge and command crates or a
  shared runtime crate?
- What is the smallest outcome vocabulary that supports cancellation and retry
  without over-specifying runtime behavior?
- Should observation batches be explicit structs or plain vectors first?

## Stop Conditions

- The type skeleton selects an async runtime or stream crate.
- The type skeleton executes or schedules effects.
- Adapters can mutate project/task/workspace state directly.
- Command-backed effects bypass server command authority.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Added type-only effect request and outcome vocabulary to
  `nucleus-scm-forge`.
- Added type-only command effect request and outcome vocabulary to
  `nucleus-command-policy`.
- Kept effect types separate from traits and runtime implementation.
- Represented cancellation, retry classification, request kinds, outcomes, and
  normalized observation batches without async, streams, scheduling, provider
  calls, command execution, persistence, or registry integration.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
