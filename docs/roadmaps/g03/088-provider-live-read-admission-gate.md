# 088 Provider Live Read Admission Gate

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Build the first fixture-backed live provider read gate.

This lane does not execute network calls. It defines the records, blockers,
preflight, request/receipt planning, and diagnostics that must exist before a
later card may call a provider API for read-only refresh.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/087-provider-readiness-coverage-and-next-provider-gate.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Represent live provider read admission without resolving credential
  material.
- [x] Model network-read authority separately from provider writes.
- [x] Preserve raw provider payload absence by default.
- [x] Produce sanitized request/receipt planning records.
- [x] Expose read-only diagnostics and no-effect flags.
- [x] Keep real provider network calls out of scope.

## Execution Plan

- [x] Add provider live-read admission records and blockers.
- [x] Add fixture-backed preflight records for credential status, network
  authority, endpoint scope, and payload policy.
- [x] Add sanitized request/receipt planning records without execution.
- [x] Persist planned live-read records and diagnostics.
- [x] Expose read-only control diagnostics.
- [x] Rebaseline before any real provider read implementation.

## Batch Cards

Completed cards:

- `batch-cards/343-provider-live-read-admission-type-surface.md`
- `batch-cards/344-provider-live-read-admission-blockers.md`
- `batch-cards/345-provider-live-read-admission-control-dto.md`
- `batch-cards/346-provider-live-read-admission-tests.md`
- `batch-cards/347-provider-live-read-preflight-type-surface.md`
- `batch-cards/348-provider-live-read-preflight-blockers.md`
- `batch-cards/349-provider-live-read-preflight-tests.md`
- `batch-cards/350-provider-live-read-request-receipt-planning.md`
- `batch-cards/351-provider-live-read-persistence-diagnostics.md`
- `batch-cards/352-provider-live-read-control-diagnostics.md`
- `batch-cards/353-provider-live-read-boundary-rebaseline.md`
- `batch-cards/354-provider-live-read-gate-validation-closeout.md`

Ready cards:

None.

## Acceptance Criteria

- [x] Live-read admission can be represented for provider read families without
  executing network I/O.
- [x] Blockers cover missing credential evidence, missing network authority,
  unsupported operation family, raw payload retention, credential material
  presence, provider writes, task mutation, callbacks, interruption, and
  recovery execution.
- [x] Request/receipt planning persists sanitized refs only.
- [x] Diagnostics expose counts, blockers, evidence refs, and no-effect flags.
- [x] Targeted Rust tests, docs QA, Northstar QA, doctor, and diff hygiene pass.

## Current Slice

Closed:

- fixture-backed admission, preflight, request/receipt planning, persistence,
  diagnostics, and control DTOs are implemented without credential resolution,
  provider network calls, provider writes, task mutation, callback,
  interruption, recovery execution, or raw provider payload retention.

Next:

- continue with `g03/089` provider live-read execution contract and adapter
  boundary planning before any real provider read implementation.

## Stop Conditions

- Stop before real provider network calls.
- Stop before credential material resolution.
- Stop before provider writes, merges, status/check writes, review workflow
  mutation, comments, labels, or branch mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
