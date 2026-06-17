# 010 Client Protocol And Host Transport Runway

Status: planned-after-012
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

- [ ] Define client protocol versioning and compatibility posture.
- [ ] Separate embedded-host, sidecar-host, remote-authoritative, and
  remote-worker connection modes.
- [ ] Define host capability advertisement and authority-map publication.
- [ ] Define pairing, session, revocation, and local-only proof modes.
- [ ] Keep final UI design out of scope.

## Execution Plan

- [ ] Protocol shape batch: define request/response/event envelope ownership.
- [ ] Host capability batch: expose host form, authority domains, and runtime
  readiness through protocol records.
- [ ] Auth posture batch: define pairing/session/revocation records without
  storing secret material in normal state.
- [ ] Transport runway batch: choose first local transport implementation and
  compile follow-on cards.

## Acceptance Criteria

- [ ] Clients can reason about which host owns which authority domain.
- [ ] Embedded and sidecar hosts can share a protocol boundary where practical.
- [ ] Remote host work has an explicit auth/pairing gate.
- [ ] The desktop app remains a light control plane, not the state authority.

## Gate

Do not start until:

- `012-health-and-authority-surface-reset.md` completes
- engine command services and projection APIs are no longer
  request-handler-owned
- `effigy doctor` has no error findings

Do not start live network listeners, pairing flows, or remote auth before the
authority-map and protocol records are stable.
