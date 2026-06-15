# 013 Adapter Secret Reference And Credential Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft adapter secret reference and credential boundary semantics.

## Scope

- Define what an adapter registry may store as a secret reference.
- Define what must never be stored directly in registry records.
- Define when secret material may be resolved for an adapter runtime.
- Distinguish host credential providers, future nucleus secret storage, and
  provider-native auth state.
- Keep credential handling separate from provider adapter implementation.

## Out Of Scope

- Secret store implementation.
- Encryption design.
- Credential UI.
- Provider login flows.
- Remote deployment trust model.

## Evidence Questions

- Which adapter fields may reference secret material?
- Which host credential systems should be representable without binding to one?
- How should external server credentials differ from local CLI auth state?
- When may a sidecar or owned process receive resolved secret material?
- What audit information can be retained without exposing credentials?

## Stop Conditions

- Registry records contain secret values.
- Provider-native auth state is copied into nucleus storage.
- Secret references imply one storage backend.
- Remote clients can request raw secret material through the control plane.

## Promotion Targets

- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-agent-adapters/src/`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft project and session model-route override semantics.
