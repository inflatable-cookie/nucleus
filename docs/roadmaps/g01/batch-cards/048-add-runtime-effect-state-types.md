# 048 Add Runtime Effect State Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect state types.

## Scope

- Add compile-only Rust state vocabulary for SCM/forge runtime effects.
- Add compile-only Rust state vocabulary for command runtime effects.
- Represent non-terminal state, terminal state, retry classification, and
  cancellation request state without schedulers.
- Keep state records value-shaped and provider-neutral.

## Out Of Scope

- Scheduler.
- Persistence.
- Replay.
- Async runtime.
- Streams.
- Process supervision.
- Event fan-out.
- Provider-specific behavior.

## Evidence Questions

- Should adapter and command state vocabularies share a generic enum?
- Does recovery required need a dedicated non-terminal state type?
- Should retry scheduling be represented as state or as a later server event?
- Are terminal states specific enough for command evidence and adapter
  observations?

## Stop Conditions

- Types imply adapters own retries or timeout policy.
- Types include runtime execution behavior.
- Types depend on dev-only fixture crates.
- Types expose raw command output or provider payloads.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Adapter and command effect state vocabularies stay separate for now.
- Recovery required is a non-terminal state.
- Cancellation requested is a non-terminal state.
- Retry scheduling is not state; retry classification is an optional field on
  state records.
- State records are value-shaped and compile-only.
- No transition validator, scheduler, persistence, replay, process supervisor,
  provider client, or event fan-out was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
