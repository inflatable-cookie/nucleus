# 010 Client Protocol And Host Transport Runway

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Prepare the client protocol and host transport model after the engine boundary
is strong enough to be embedded, sidecar-hosted, or remote-hosted.

This roadmap is the protocol/transport runway. The concrete host authority-map
record work is sequenced in
`013-host-authority-map-and-client-protocol-records.md`.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/architecture/system-architecture.md`

## Goals

- [x] Define client protocol versioning and compatibility posture.
- [x] Separate embedded-host, sidecar-host, remote-authoritative, and
  remote-worker connection modes.
- [x] Define host capability advertisement and authority-map publication.
- [x] Define pairing, session, revocation, and local-only proof modes.
- [x] Keep final UI design out of scope.

## Execution Plan

- [x] Protocol shape batch: define request/response/event envelope ownership.
- [x] Host capability batch: expose host form, authority domains, and runtime
  readiness through protocol records.
- [x] Auth posture batch: define pairing/session/revocation records without
  storing secret material in normal state.
- [x] Transport runway batch: choose first local transport implementation and
  compile follow-on cards.

## Local Transport Selection

First desktop/local implementation target: Tauri IPC.

Reason:

- it matches the initial desktop control plane
- it keeps renderer code as a client, not authority
- it can use the existing request/response DTO and protocol profile work
- it avoids opening a socket before local auth and host authority-map records
  are stronger

In-process transport remains the test fixture and embedded-host fallback.

Deferred options:

- local socket or named pipe: useful for sidecar and CLI clients after host
  authority-map and auth posture records mature
- loopback HTTP: useful later, but it pulls in auth, pairing, revocation, and
  listener lifecycle too early
- LAN/remote HTTP or WebSocket: out of scope until remote auth and authority
  maps have explicit gates

Follow-on implementation cards should be compiled after `013`:

- Tauri IPC protocol-profile query
- Tauri IPC host-capability query
- Tauri IPC client-auth posture query
- sidecar local transport readiness comparison

## Batch Cards

Completed cards:

- `batch-cards/041-client-protocol-envelope-profile.md`
- `batch-cards/042-host-capability-advertisement-records.md`
- `batch-cards/043-client-auth-posture-records.md`
- `batch-cards/044-local-transport-selection-runway.md`

## Acceptance Criteria

- [x] Clients can reason about which host owns which authority domain.
- [x] Embedded and sidecar hosts can share a protocol boundary where practical.
- [x] Remote host work has an explicit auth/pairing gate.
- [x] The desktop app remains a light control plane, not the state authority.

## Closeout

Completed 2026-06-17.

This milestone established protocol profile, host capability advertisement,
client auth posture projection, and first local transport direction. It did not
open a listener, add remote auth, implement pairing, or make the desktop the
authority.

## Gate

Do not start until:

- `012-health-and-authority-surface-reset.md` completes
- engine command services and projection APIs are no longer
  request-handler-owned
- `effigy doctor` has no error findings

Do not start live network listeners, pairing flows, or remote auth before the
authority-map and protocol records are stable.
