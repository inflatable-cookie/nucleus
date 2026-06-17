# 013 Host Authority Map And Client Protocol Records

Status: completed
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

- [x] Define typed host identity, host form, capability, and authority-map
  records in the portable engine/server boundary.
- [x] Define client protocol envelope versioning and compatibility posture.
- [x] Expose host capability and authority-map read models without creating a
  remote auth implementation.
- [x] Keep embedded, sidecar, remote-authoritative, and remote-worker modes
  distinguishable.

## Execution Plan

- [x] Authority-map record batch: add focused records and validation rules.
- [x] Protocol envelope batch: define versioned request, response, event, and
  error envelope records.
- [x] Host capability batch: expose host form, authority domains, readiness,
  and advertised limits.
- [x] Query/projection batch: add read-only query paths for clients.

## Batch Cards

Completed cards:

- `batch-cards/045-project-authority-map-record-shape.md`
- `batch-cards/046-host-authority-read-model-query.md`
- `batch-cards/047-protocol-authority-map-dto.md`
- `batch-cards/048-host-authority-map-validation.md`

## Acceptance Criteria

- [x] Clients can inspect which host owns which authority domains.
- [x] Embedded and sidecar host modes share protocol records where practical.
- [x] Remote host records expose auth posture without storing secret material.
- [x] No network listener, pairing flow, or live remote transport is started.

## Closeout

Completed 2026-06-17.

This milestone established client-visible authority-map publication records,
read-only query routing, and response DTOs. Missing authority-map persistence
is represented as deferred publication rather than fabricated authority.

## Gate

Do not start live remote transport until authority-map records and client
protocol envelopes are stable enough to version.
