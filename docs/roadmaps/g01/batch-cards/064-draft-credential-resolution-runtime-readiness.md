# 064 Draft Credential Resolution Runtime Readiness

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft credential resolution runtime readiness.

## Scope

- Define what must be true before any credential resolution implementation can
  begin.
- Name runtime surfaces for backend lookup, user prompting, policy checks,
  audit capture, redaction, and repair work.
- Separate readiness from implementation.
- Batch with compile-only readiness vocabulary if stable enough.

## Out Of Scope

- Secret backend implementation.
- Credential prompting implementation.
- Command execution implementation.
- Provider auth implementation.
- UI implementation.
- Secret material access.

## Evidence Questions

- Which runtime boundaries can receive resolved material?
- What policy checks must happen before lookup?
- What audit evidence is safe to retain?
- Which blockers should produce repair tasks versus transient runtime errors?

## Stop Conditions

- The draft resolves real credentials.
- The draft stores raw material in normal state.
- The draft chooses a backend.
- The draft implements prompting or command execution.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`
- `crates/nucleus-server`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
