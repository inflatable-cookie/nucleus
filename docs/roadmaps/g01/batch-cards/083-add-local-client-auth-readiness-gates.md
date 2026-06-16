# 083 Add Local Client Auth Readiness Gates

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add local-only client identity and auth readiness boundaries before network
pairing work begins.

## Scope

- Define local client identity records.
- Define deployment posture checks for unpaired local clients.
- Keep remote pairing and account identity deferred.
- Add tests for denied unsupported auth states.

## Out Of Scope

- Remote pairing.
- User account service.
- Token exchange.
- Browser/device auth flows.
- Transport-specific auth middleware.

## Promotion Targets

- `crates/nucleus-server`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Local auth readiness lives in `client_auth.rs` alongside existing auth and
  pairing vocabulary.
- `ClientAuthDeploymentPolicy::evaluate_local_client` is a readiness gate, not
  an auth mechanism.
- Explicit local-only unpaired desktop/CLI access can be ready.
- Unsupported client kinds, revoked clients, and incomplete pairing can be
  denied.
- Remote login, managed identity, and service credential postures are deferred
  instead of silently accepted.

## Closeout

Added local client auth readiness status, blocker vocabulary, and deployment
policy evaluation.

Tests cover explicit local-only unpaired desktop access, unsupported client
denial, and deferred remote login. No remote pairing, user account service,
token exchange, browser/device auth flow, transport middleware, or command
approval behavior was added.
