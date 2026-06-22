# 094 Provider Live Read Executor Control Surface

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose the server-owned provider live-read executor through read-only control
surfaces so it can be inspected and driven by the server boundary without
turning into broad provider execution.

This lane should keep the current repository metadata executor narrow:
approved request records, field-limited `gh repo view` descriptors, sanitized
output records, receipts, and diagnostics. It must not add provider writes,
task mutation, callback/interruption/recovery execution, credential material
storage, raw provider payload retention, or UI product hardening.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/093-provider-live-read-server-owned-executor.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a read-only server query/control DTO for executor diagnostics.
- [x] Add a `nucleusd`/Effigy inspection path for the executor proof surface.
- [x] Keep command execution explicit and auditable.
- [x] Keep all provider-write and task-mutation authority blocked.

## Execution Plan

- [x] Add query vocabulary and response DTOs for executor diagnostics.
- [x] Add request-handler/control-envelope route coverage.
- [x] Add `nucleusd query` and Effigy selector wiring if the DTO is stable.
- [x] Validate docs and code boundary hygiene.

## Batch Cards

Completed cards:

- `batch-cards/373-provider-live-read-executor-query-vocabulary.md`
- `batch-cards/374-provider-live-read-executor-control-dto.md`
- `batch-cards/375-provider-live-read-executor-nucleusd-effigy-query.md`
- `batch-cards/376-provider-live-read-executor-control-validation.md`

## Acceptance Criteria

- [x] Executor diagnostics are inspectable through a read-only server-owned
  surface.
- [x] The surface exposes sanitized ids, status counts, blocker counts, and
  no-effect flags only.
- [x] No raw provider payload, credential material, provider writes, task
  mutation, callback/interruption/recovery execution, or broad UI behavior is
  added.
- [x] Validation proves the DTO/query path and existing executor tests.

## Current Slice

Completed:

- implemented cards 373-376 as one read-only control integration batch.
- `effigy server:query:provider-live-read-executor` renders sanitized
  no-effect diagnostics.
- next lane: add an explicit read-only command-runner handoff for the approved
  field-limited executor descriptor.

## Stop Conditions

- Stop before adding provider writes, status/check writes, comments, review
  actions, labels, branch mutation, merges, or pull-request mutation.
- Stop before adding automatic live provider execution from UI actions.
- Stop before raw provider payload retention or credential material storage.
