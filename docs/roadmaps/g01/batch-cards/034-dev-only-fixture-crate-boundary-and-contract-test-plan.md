# 034 Dev Only Fixture Crate Boundary And Contract Test Plan

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft dev-only fixture crate boundary and contract-test plan.

## Scope

- Decide where fake adapter and fixture builders should live.
- Define dev-only crate or module boundaries for contract tests.
- Define which fixtures become integration tests first.
- Keep production crates free of fixture-builder APIs.
- Sequence first contract tests before live SCM or forge adapters.

## Decisions

- Use a dev-only crate named `nucleus-contract-fixtures`.
- Mark it `publish = false`.
- Allow it to depend on production type-only crates.
- Forbid production crates from depending on it.
- Keep fixture builders out of stable production APIs.
- Forbid process spawning, shell execution, network access, and live
  credentials inside fixtures.

## First Contract Tests

Initial contract tests should cover:

- Git-like SCM workflow semantics.
- Convergence-like SCM workflow semantics.
- Provider-neutral task links preserve Nucleus ids.
- Credential failure fixtures retain sanitized evidence only.
- Webhook rejection fixtures retain sanitized evidence only.
- Command policy fixtures cover allowed, approval-required, blocked, failed,
  and timed-out states.
- Conflict fixtures distinguish SCM file conflicts from semantic task
  conflicts.
- Review fixtures retain rejected or abandoned work as audit state.

## Out Of Scope

- Implementing fixture builders.
- Implementing fake adapters.
- Implementing live adapters.
- Running real SCM or forge commands.
- Adding CI workflows.

## Evidence Questions

- Should fixtures live in one dev-only crate or per-domain test modules?
- Which fixtures should be public to integration tests?
- Which fixtures are crate-private unit test helpers?
- How should fake adapters avoid accidental production linkage?
- Which contract tests gate the first Git adapter work?

## Stop Conditions

- Fixture builders are exported as stable production API.
- Contract tests require live credentials.
- Git-specific fixtures are the only provider-neutral proof.
- Fake adapters spawn commands or use network.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- future dev-only fixture crate or test modules

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
