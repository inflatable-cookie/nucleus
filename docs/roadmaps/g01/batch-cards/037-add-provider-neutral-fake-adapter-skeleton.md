# 037 Add Provider-Neutral Fake Adapter Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add provider-neutral fake adapter skeleton.

## Scope

- Add dev-only fake adapter module placeholders under
  `nucleus-contract-fixtures`.
- Keep fake adapters offline, deterministic, and test-support only.
- Separate SCM, forge, and command-policy fake surfaces.
- Reuse existing fixture constructors where possible.
- Add no process spawning, shell execution, network, credential lookup, or
  provider SDK calls.

## Out Of Scope

- Production adapter traits.
- Real Git, Convergence, forge, or command execution.
- Runtime adapter registry integration.
- Persistence, async workers, or server APIs.
- CI workflow changes.

## Evidence Questions

- Which fake adapter surface needs behavior first: SCM observation, forge
  observation, or command policy?
- Should fake adapters return plain value records or scripted event streams?
- Which behavior is required by the next contract test without becoming a
  production API promise?

## Stop Conditions

- Fake adapters depend on production runtime crates.
- Any fake adapter opens network, spawns a process, reads credentials, or
  shells out.
- Fake behavior starts mirroring a specific provider too closely.
- The skeleton forces Git terms onto non-Git providers.

## Promotion Targets

- `crates/nucleus-contract-fixtures`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Added dev-only fake adapter skeletons for command policy, SCM, and forge
  surfaces under `nucleus-contract-fixtures`.
- Fake adapters expose deterministic scripted value records only.
- The skeleton returns existing production boundary types without implementing
  production adapter traits, runtime registry integration, process spawning,
  network access, or credential lookup.
- SCM fake surfaces separate Git-like and Convergence-like workflow semantics.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
