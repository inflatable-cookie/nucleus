# 061 Draft Client Auth And Pairing Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft client auth and pairing boundary.

## Scope

- Draft local, LAN, remote, and managed remote client auth posture.
- Define pairing requirements for desktop, web, mobile, CLI, and service
  clients.
- Separate client auth from transport selection, event replay, subscriptions,
  command approval, secret storage, and provider credentials.
- Define revocation, client identity, and session posture enough to unblock
  transport readiness.
- Batch with initial compile-only auth/pairing vocabulary if the boundary is
  stable enough.

## Out Of Scope

- Auth implementation.
- Credential or secret store implementation.
- OAuth, passkey, mTLS, token, or pairing-code selection.
- Transport implementation.
- Command approval implementation.
- Runtime execution.

## Evidence Questions

- Which deployment modes need pairing versus normal login?
- Which client kinds need different auth posture?
- What is the minimum durable client identity record?
- How does revocation interact with active subscriptions and replay tokens?
- Which auth decisions block transport implementation readiness?

## Stop Conditions

- The draft chooses a concrete auth mechanism too early.
- The draft stores credential material in normal server state.
- The draft lets transport identity replace server-owned client identity.
- The draft confuses client auth with command approval or provider
  credentials.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
