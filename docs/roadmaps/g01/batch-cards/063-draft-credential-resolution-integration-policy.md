# 063 Draft Credential Resolution Integration Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft credential resolution integration policy.

## Scope

- Connect server secret material refs to client auth, adapter registry, model
  routes, SCM/forge adapters, webhooks, and command policy.
- Define resolution request lifecycle without implementing a backend.
- Define missing, expired, revoked, permission-denied, and requires-user-action
  flows as repair or policy states.
- Decide which existing crate-specific credential refs need mapping types.
- Batch with compile-only integration vocabulary if stable enough.

## Out Of Scope

- Secret backend implementation.
- Credential prompting implementation.
- Command execution implementation.
- Provider auth implementation.
- Auth mechanism selection.
- UI implementation.

## Evidence Questions

- Which crate-specific refs should map to server credential material refs?
- Which runtime boundaries may receive resolved material?
- How should missing credential repair work be represented?
- Which resolution outcomes should block command execution versus adapter
  readiness versus model routing?

## Stop Conditions

- The draft resolves real credentials.
- The draft stores raw material in normal state.
- The draft lets command approval imply credential access.
- The draft collapses provider-native auth into Nucleus-owned secrets.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/004-model-routing-contract.md`
- `docs/architecture/system-inventory.md`

## Decisions

- Credential resolution integration maps domain-specific refs to server-owned
  credential material refs.
- Integration records carry runtime scope, non-secret status, blocking impact,
  and repair action.
- Missing, expired, revoked, permission-denied, requires-user-action, and
  unsupported states become repair or policy blockers.
- Blocking impacts can target client auth, adapter readiness, model routes,
  SCM/forge access, webhook verification, command execution, or repair.
- Command approval does not imply credential access. Credential access does
  not imply command approval.
- Provider-native auth remains provider-owned unless a later import policy says
  otherwise.
- Initial compile-only integration vocabulary was added in `nucleus-server`.
- No credential resolution, prompting, backend access, command execution,
  provider calls, secret injection, or UI implementation was added.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
