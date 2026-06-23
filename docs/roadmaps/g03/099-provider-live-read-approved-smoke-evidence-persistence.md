# 099 Provider Live Read Approved Smoke Evidence Persistence

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Persist promoted approved provider live-read smoke evidence as sanitized local
store records.

This lane turns the first manual `gh repo view octocat/Hello-World` smoke into
a durable server-owned record shape without adding automatic provider command
execution, provider writes, UI-triggered reads, credential storage, or raw
provider payload retention.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/097-provider-live-read-approved-smoke-evidence-promotion.md`
- `docs/roadmaps/g03/098-provider-live-read-approved-smoke-evidence-control-surface.md`

## Goals

- [x] Add persistence input/set/record vocabulary for promoted smoke evidence.
- [x] Persist selected-field evidence through the local-store artifact metadata
  repository.
- [x] Read persisted records back without raw provider payloads or credential
  material.
- [x] Keep duplicate, unpromoted, and effectful records represented without
  performing provider effects.

## Execution Plan

- [x] Add persistence types that preserve evidence linkage and no-effect flags.
- [x] Add local-store write/read helpers for promoted records only.
- [x] Add tests for round-trip, duplicate noop, and blocked records.
- [x] Validate the provider live-read test slice and docs state.

## Batch Cards

Completed cards:

- `batch-cards/393-provider-live-read-approved-smoke-evidence-persistence-types.md`
- `batch-cards/394-provider-live-read-approved-smoke-evidence-persistence-store.md`
- `batch-cards/395-provider-live-read-approved-smoke-evidence-persistence-tests.md`
- `batch-cards/396-provider-live-read-approved-smoke-evidence-persistence-validation.md`

## Acceptance Criteria

- [x] Promoted approved smoke evidence can be persisted and read back from
  local store.
- [x] Persisted records contain selected fields and linkage ids, not raw
  provider payloads or credentials.
- [x] Duplicate records are represented as noops.
- [x] Unpromoted or effectful records are blocked.
- [x] No provider command execution is added.

## Current Slice

Completed:

- implemented cards 393-396 as one persistence batch.
- approved smoke evidence can now move from promoted in-memory evidence to a
  durable local-store record.

## Stop Conditions

- Stop before automatic provider command execution.
- Stop before UI-triggered provider reads.
- Stop before provider writes, comments, status/check writes, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before storing raw provider stdout/stderr, headers, response bodies, or
  credential material.
