# 044 Add Adapter Runtime Effect Type Compile Tests

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add adapter runtime effect type compile tests.

## Scope

- Add compile-focused tests for SCM/forge and command effect type skeletons.
- Prove observation batches, cancellation posture, retry classification, and
  outcome variants can be composed without runtime behavior.
- Keep tests offline and provider-neutral.
- Use local values only.

## Out Of Scope

- Effect traits.
- Runtime execution.
- Async, streams, polling, webhooks, command execution, persistence, or replay.
- Provider-specific behavior.

## Evidence Questions

- Are request ids and outcome ids split correctly?
- Are retry classifications too broad or too narrow?
- Do outcome variants need separate accepted/queued/running status records
  before effect traits are drafted?

## Stop Conditions

- Tests require runtime behavior.
- Tests depend on dev-only fixture APIs.
- Tests imply adapters mutate project/task/workspace state directly.
- Tests bypass server-owned command authority.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Decisions

- SCM/forge effect type tests live beside production effect types and use local
  values only.
- Command effect type tests live beside production command effect types and use
  sanitized evidence only.
- The tests keep effect request ids separate from command request ids and prove
  request/outcome linkage without runtime execution.
- Retry classification, cancellation posture, observation batches, queued
  outcomes, blocked-policy outcomes, and timed-out outcomes are enough for the
  next trait-boundary draft.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
