# 013 Host Authority Map And Client Protocol Records

Status: planned-after-010
Owner: Tom
Updated: 2026-06-17

## Purpose

Turn the engine-host authority model and client protocol runway into concrete
records before remote, sidecar, or embedded host behavior expands.

This milestone follows the health reset and complements
`010-client-protocol-and-host-transport-runway.md`.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/roadmaps/g02/010-client-protocol-and-host-transport-runway.md`

## Goals

- [ ] Define typed host identity, host form, capability, and authority-map
  records in the portable engine/server boundary.
- [ ] Define client protocol envelope versioning and compatibility posture.
- [ ] Expose host capability and authority-map read models without creating a
  remote auth implementation.
- [ ] Keep embedded, sidecar, remote-authoritative, and remote-worker modes
  distinguishable.

## Execution Plan

- [ ] Authority-map record batch: add focused records and validation rules.
- [ ] Protocol envelope batch: define versioned request, response, event, and
  error envelope records.
- [ ] Host capability batch: expose host form, authority domains, readiness,
  and advertised limits.
- [ ] Query/projection batch: add read-only query paths for clients.

## Acceptance Criteria

- [ ] Clients can inspect which host owns which authority domains.
- [ ] Embedded and sidecar host modes share protocol records where practical.
- [ ] Remote host records expose auth posture without storing secret material.
- [ ] No network listener, pairing flow, or live remote transport is started.

## Gate

Do not start live remote transport until authority-map records and client
protocol envelopes are stable enough to version.
