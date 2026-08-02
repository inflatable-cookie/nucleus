# 016 Optional Backend Bridge Alignment

Status: local alignment completed; remote transport gated
Owner: Tom
Created: 2026-08-01

## Purpose

Align Nucleus host sessions with Longhorn's transport-independent bridge model
without creating a second domain protocol or pretending a production remote
transport already exists.

## Governing Refs

- `../../contracts/007-server-boundary-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/007-optional-backend-topology.md`

## Generation Runway Goal

Prepare local and remote host forms to share connection and authority semantics.

## Goals

- [x] reconcile Longhorn bridge identity with Nucleus control envelopes
- [x] preserve per-domain Nucleus authority and typed DTOs
- [x] compose direct and Tauri-local paths through one session authority
- [x] leave production remote transport behind an explicit contract gate

## Execution Plan

### Batch 16.1 — Protocol And Authority Reconciliation

- [x] Execute card 048.
- [x] map session, host, capability, authority, revision, and correlation types
- [x] reject duplicate payload or command vocabularies

### Batch 16.2 — Local Composition

- [x] Execute card 049 through consumer-native Tauri invocation.
- [x] preserve direct and Tauri-local semantics through one assembly
- [x] expose reconnect, incompatible, unauthorized, and offline truth

### Batch 16.3 — Remote Transport Gate

- [ ] Execute card 050 only after the remote host pairing/session contract is
  promoted.
- [ ] select production transport, discovery, security, and lifecycle evidence
- [ ] do not infer remote readiness from loopback conformance

## Acceptance Criteria

- [x] domain commands and DTOs remain Nucleus-owned
- [x] connection capability and write authority remain separate
- [x] stale sessions and authority epochs cannot overwrite current state
- [x] uncertain writes are never retried silently
- [x] no production remote-support claim exists before native evidence

## Batch Cards

- `batch-cards/048-bridge-authority-reconciliation.md`
- `batch-cards/049-local-bridge-composition.md`
- `batch-cards/050-production-remote-transport-gate.md`

## Planning Gap

Contract 032 permits bridge alignment but not production remote transport. The
needed remote host pairing/session contract remains listed in the contract
index and must be promoted before card 050 becomes ready.

Consumer-native Tauri invocation now passes against Nucleus's real generated
capability context and the production command registrations. This remains a
local-host proof and grants no production remote-transport claim.
