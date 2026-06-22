# 095 Provider Live Read Executor Command Runner Handoff

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Bridge the provider live-read executor descriptor to the existing read-only
command-runner boundary without making live provider reads implicit.

This lane should prepare the field-limited `gh repo view` descriptor for a
server-owned read-only spawn path, capture sanitized stdout metadata into the
existing executor output records, and emit receipts/diagnostics. It must remain
operator-gated and read-only.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/093-provider-live-read-server-owned-executor.md`
- `docs/roadmaps/g03/094-provider-live-read-executor-control-surface.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a command-runner handoff record for ready executor descriptors.
- [x] Keep `gh repo view` field selection fixed and auditable.
- [x] Feed sanitized command stdout into repository metadata output parsing.
- [x] Keep provider writes, raw payload retention, and task mutation blocked.

## Execution Plan

- [x] Add read-only command handoff records from executor descriptors.
- [x] Add command-runner result mapping into sanitized output and receipts.
- [x] Add control diagnostics for handoff-ready and blocked states.
- [x] Validate without running broad suites or provider writes.

## Batch Cards

Completed cards:

- `batch-cards/377-provider-live-read-command-handoff-records.md`
- `batch-cards/378-provider-live-read-command-result-mapping.md`
- `batch-cards/379-provider-live-read-command-handoff-diagnostics.md`
- `batch-cards/380-provider-live-read-command-handoff-validation.md`

## Acceptance Criteria

- [x] Handoff records can be built from ready field-limited descriptors.
- [x] Handoff records cannot express provider writes or task mutation.
- [x] Sanitized stdout parsing still does not retain raw provider payloads.
- [x] Diagnostics distinguish ready, blocked, parsed, parse-error, and
  read-performed states.
- [x] `nucleusd`/Effigy inspection remains read-only.

## Current Slice

Completed:

- implemented cards 377-380 as one read-only command-runner handoff batch.
- targeted provider live-read tests pass.
- next lane: explicit operator-gated command-runner live smoke approval.

## Stop Conditions

- Stop before provider writes, comments, status/check writes, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before automatic UI-triggered live provider execution.
- Stop before storing raw provider stdout/stderr, headers, response bodies, or
  credential material.
