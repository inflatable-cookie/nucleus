# 062 Draft Secret Store And Credential Material Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft secret store and credential material boundary.

## Scope

- Draft where credential material may live for client auth, provider auth,
  model routes, SCM/forge adapters, command execution, and webhooks.
- Separate credential references from credential material.
- Define host credential provider, OS keychain, external secret manager,
  provider-native auth, and future built-in secret store as possible backends
  without selecting one.
- Define audit, rotation, revocation, redaction, and access-policy posture.
- Batch with first compile-only secret reference vocabulary if stable enough.

## Out Of Scope

- Secret store implementation.
- Backend selection.
- Encryption implementation.
- OS keychain integration.
- Provider auth implementation.
- Command execution implementation.

## Evidence Questions

- Which credential material classes must be named before implementation?
- Which surfaces may hold only refs versus material?
- How should revocation flow across client auth, provider auth, model routes,
  SCM/forge adapters, and command policy?
- What redaction and audit records are safe in normal server storage?

## Stop Conditions

- The draft stores raw secrets in normal durable state.
- The draft chooses a secret backend too early.
- The draft treats provider-native auth files as ordinary Nucleus records.
- The draft mixes command approval with credential access.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
