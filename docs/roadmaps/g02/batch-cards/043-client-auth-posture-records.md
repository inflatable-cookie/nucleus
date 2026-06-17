# 043 Client Auth Posture Records

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../010-client-protocol-and-host-transport-runway.md`

## Purpose

Define client-visible auth, pairing, session, and revocation posture records
without implementing credentials or remote login.

## Scope

- Add records that describe local-only, pairing-required, login-required,
  managed-identity, service-credential, revoked, and custom postures.
- Keep secret material out of normal state.
- Separate client identity, auth posture, command approval, and provider
  credential access.
- Update server boundary docs if the existing client auth section needs a
  narrower owner.

## Acceptance Criteria

- Clients can render why a host connection is allowed, blocked, deferred, or
  revoked.
- Auth posture records do not imply command approval.
- Credential material is represented only by non-secret refs.
- No OAuth, passkey, mTLS, token, invite, or pairing-code mechanism is chosen.

## Validation

- `cargo test -p nucleus-server client_auth`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if a real auth mechanism must be selected.

## Outcome

Completed 2026-06-17.

Added client-visible auth posture projection records. The records explain
allowed, blocked, deferred, and revoked states; carry only non-secret
credential references; and keep command approval and provider credential access
outside client authentication.
