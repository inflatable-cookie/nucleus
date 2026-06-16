# 035 Scaffold Dev Only Contract Fixture Crate

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add dev-only contract fixture crate skeleton.

## Scope

- Add `nucleus-contract-fixtures` as a `publish = false` workspace crate.
- Keep it clearly test-support only.
- Add module placeholders for SCM/forge and command-policy fixtures.
- Add no process spawning, network, shell, credential, or live-provider logic.
- Add compile-only tests if useful to prove fixture vocabulary compiles.

## Out Of Scope

- Implementing fake adapters.
- Implementing fixture builders with behavior.
- Running live SCM or forge commands.
- Adding command execution.
- Adding CI workflows.

## Evidence Questions

- Which production type-only crates should the fixture crate depend on first?
- Which fixture modules should exist before builders?
- Should fixture builders be public to integration tests from the start?
- Which compile-only tests prove the crate boundary without creating behavior?

## Stop Conditions

- Production crates depend on `nucleus-contract-fixtures`.
- The fixture crate spawns commands or opens network.
- Fixture builders become stable production API.
- Live credentials are needed to run tests.

## Promotion Targets

- `Cargo.toml`
- `crates/nucleus-contract-fixtures`
- `docs/architecture/system-inventory.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Decisions

- Added `nucleus-contract-fixtures` as an unpublished workspace crate.
- Kept the crate to fixture profile vocabulary and compile-only checks.
- Left fake adapters, live provider behavior, command execution, and network
  access out of scope.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
