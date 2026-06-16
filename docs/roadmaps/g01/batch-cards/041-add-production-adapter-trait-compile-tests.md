# 041 Add Production Adapter Trait Compile Tests

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add production adapter trait compile tests.

## Scope

- Add compile-focused tests for the static production trait skeletons.
- Implement tiny local test structs only inside tests.
- Prove SCM, forge, observation source, and command authority trait methods
  can be implemented without async, network, process execution, or registry
  integration.
- Keep tests provider-neutral and offline.

## Out Of Scope

- Real adapter implementations.
- Fake adapter promotion into production crates.
- Async runtime or stream type selection.
- Command execution, webhooks, polling, persistence, or replay.
- Provider-specific behavior.

## Evidence Questions

- Which trait methods need clearer naming after compile tests?
- Do required command scopes belong on both SCM and forge traits?
- Does the command authority trait need separate policy-inspection and
  execution traits later?

## Stop Conditions

- Tests require live providers, network, shell, or credentials.
- Test structs become reusable production implementations.
- Trait tests rely on dev-only fixture APIs.
- Trait methods force Git terms onto non-Git providers.

## Promotion Targets

- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Decisions

- Added compile-focused trait tests inside the production crates.
- Used tiny local test structs only.
- Proved SCM, forge, observation source, and command authority trait skeletons
  can be implemented without async, streaming, process execution, network,
  registry integration, or dev-only fixture APIs.
- Kept provider behavior out of the tests.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
