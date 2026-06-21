# 014 Convergence Publication Request Persistence

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Persist Convergence-like stopped publication request records with duplicate-safe
idempotency outcomes before any publication runner is introduced.

## Governing Refs

- `docs/roadmaps/g03/013-convergence-publication-command-boundary.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Goals

- [x] Persist stopped request records by stable idempotency key.
- [x] Make duplicate request persistence deterministic.
- [x] Expose request persistence diagnostics through read-only DTOs.
- [x] Keep all execution effects false.

## Execution Plan

- [x] Request persistence batch.
- [x] Request control DTO batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/055-convergence-publication-request-persistence.md`
- `batch-cards/056-convergence-publication-request-control-dto.md`
- `batch-cards/057-convergence-publication-request-persistence-closeout.md`

## Acceptance Criteria

- [x] Persistence records preserve request, descriptor, preflight, admission,
  projection, task, repo, idempotency, and provider-stage refs.
- [x] Duplicate idempotency keys produce duplicate no-op outcomes.
- [x] Read-only DTOs expose persisted, duplicate, and blocked counts.
- [x] No snapshot creation, publish execution, review publication, provider
  write, task mutation, callback, interruption, recovery, or raw-output effect
  is added.
