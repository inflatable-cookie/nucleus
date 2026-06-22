# 093 Provider Live Read Server-Owned Executor

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Build the first server-owned provider live-read executor for read-only
repository metadata refresh.

This lane may wrap the already-proven `gh` read path behind Nucleus-owned
admission, authority, receipt, sanitization, and diagnostics records. It must
not add provider writes, raw payload retention, task mutation, callbacks,
interruption, or recovery execution.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/092-provider-live-read-smoke-closeout-and-executor-selection.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add a read-only executor request type for repository metadata refresh.
- [x] Use server-owned command admission and sanitized output shaping.
- [x] Produce runtime receipt and sanitized evidence records.
- [x] Keep credential material and raw provider payloads out of persistence.
- [x] Keep writes and task mutation blocked.

## Execution Plan

- [x] Add executor request and blocker records.
- [x] Add a read-only `gh repo view` command descriptor for selected fields.
- [x] Add sanitized output parser and evidence record.
- [x] Add receipt/diagnostics records.
- [x] Add validation and boundary rebaseline.

## Batch Cards

Completed cards:

- `batch-cards/368-provider-live-read-executor-request-records.md`
- `batch-cards/369-provider-live-read-gh-command-descriptor.md`
- `batch-cards/370-provider-live-read-sanitized-output-records.md`
- `batch-cards/371-provider-live-read-executor-receipts-diagnostics.md`
- `batch-cards/372-provider-live-read-executor-validation-closeout.md`

## Acceptance Criteria

- [x] Executor request records derive from approved smoke records.
- [x] The command descriptor is read-only and field-limited.
- [x] Sanitized output records contain no credential material, raw headers, or
  raw response bodies.
- [x] Receipts state whether a provider network call was performed.
- [x] Provider writes, task mutation, callback/interruption/recovery execution,
  and raw payload retention remain blocked.

## Current Slice

Completed:

- implemented cards 368-372 as one server-owned read-only executor batch.
- targeted provider live-read tests pass.
- next lane: expose the executor through a read-only control/query surface.

## Stop Conditions

- Stop before provider writes, status/check writes, comments, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
