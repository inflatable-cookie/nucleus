# 050 Add Runtime Effect Event Types

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect event types.

## Scope

- Add compile-only Rust event envelope vocabulary for runtime effect events.
- Add compile-only adapter effect event payload vocabulary.
- Add compile-only command effect event payload vocabulary.
- Keep event types value-shaped and provider-neutral.
- Keep event refs symbolic until storage and replay contracts exist.

## Out Of Scope

- Event bus.
- Transport.
- Replay.
- Persistence.
- Client subscriptions.
- Scheduler.
- Runtime execution.
- Provider-specific payloads.

## Evidence Questions

- Where should shared server event ids live before server event contracts are
  expanded?
- Should adapter and command effect events share one enum or separate payload
  structs?
- Which refs should be typed now versus symbolic strings until storage exists?
- How much event ordering vocabulary is safe before replay exists?

## Stop Conditions

- Types imply event transport, persistence, replay, or subscriptions.
- Types include raw provider payloads, raw command output, credentials, or
  machine-local paths.
- Types make clients authoritative for effect state.
- Types depend on dev-only fixture crates.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Shared runtime effect event envelope types live in `nucleus-server`.
- Adapter runtime effect event payload types live in `nucleus-scm-forge`.
- Command runtime effect event payload types live in `nucleus-command-policy`.
- Refs remain symbolic strings until storage and replay contracts exist.
- Event types are value-shaped and compile-only.
- No event bus, transport, replay, persistence, client subscriptions, scheduler,
  runtime execution, or provider-specific payloads were added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
