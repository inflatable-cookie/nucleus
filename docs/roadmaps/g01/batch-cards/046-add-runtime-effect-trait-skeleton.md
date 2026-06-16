# 046 Add Runtime Effect Trait Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add runtime effect trait skeleton.

## Scope

- Add compile-only Rust trait skeletons for SCM/forge runtime effect acceptance
  and outcome reporting.
- Add compile-only Rust trait skeletons for command runtime effect acceptance
  and sanitized evidence outcome reporting.
- Keep traits value-shaped.
- Keep server-owned scheduling, retry, timeout, approval, persistence, command
  execution, output retention, dedupe, and event fan-out out of the traits.

## Out Of Scope

- Async runtime.
- Streams.
- Polling workers.
- Webhook server.
- PTY or process runner.
- Sandbox backend.
- Artifact store.
- Replay store.
- Provider-specific behavior.
- Runtime execution tests.

## Evidence Questions

- Should acceptance and outcome reporting be separate traits in Rust?
- Which acceptance states need to be explicit before command runners exist?
- Do SCM/forge and command effect traits need shared readiness vocabulary?
- Should cancellation outcome reporting use the existing outcome enums only?

## Stop Conditions

- Trait skeletons require async, streams, real execution, persistence, or
  provider clients.
- Trait skeletons let adapters mutate project, task, workspace, projection, or
  history state directly.
- Trait skeletons bypass server command authority.
- Trait skeletons depend on dev-only fixture crates.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Runtime effect acceptance and outcome reporting are separate Rust trait
  surfaces.
- SCM and forge runtime effect traits live in `nucleus-scm-forge` under a
  focused `runtime_effects` module.
- Command runtime effect traits live in `nucleus-command-policy` under a
  focused `runtime_effects` module.
- The traits use existing request, outcome, readiness, cancellation, and retry
  vocabulary.
- The traits stay value-shaped and compile-only.
- Local unit tests prove composition without async, streams, execution,
  persistence, provider clients, or dev-only fixtures.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
