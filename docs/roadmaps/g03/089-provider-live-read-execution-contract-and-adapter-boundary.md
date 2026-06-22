# 089 Provider Live Read Execution Contract And Adapter Boundary

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Define the first real provider read execution boundary after the fixture-backed
gate.

This lane may plan contracts, type surfaces, fixture clients, credential lease
records, request/response sanitization, and stopped executor handoff records.
It must not call a provider network or resolve credential material.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/088-provider-live-read-admission-gate.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Separate credential lease metadata from credential material.
- [x] Define a provider read client boundary that can be implemented by
  GitHub/GitLab-like adapters later.
- [x] Preserve sanitized request, response, receipt, and error evidence shapes.
- [x] Keep fixture clients and stopped executor records ahead of live network
  calls.
- [x] Require explicit operator approval before any later real provider read.

## Execution Plan

- [x] Promote the live-read execution contract delta.
- [x] Add fixture provider-client traits and typed request/response envelopes.
- [x] Add stopped executor handoff records from persisted live-read plans.
- [x] Add sanitized response/error fixture records and diagnostics.
- [x] Rebaseline before any live provider read smoke.

## Batch Cards

Completed cards:

- `batch-cards/355-provider-live-read-execution-contract-delta.md`
- `batch-cards/356-provider-live-read-fixture-client-boundary.md`
- `batch-cards/357-provider-live-read-stopped-executor-handoff.md`
- `batch-cards/358-provider-live-read-fixture-response-diagnostics.md`
- `batch-cards/359-provider-live-read-execution-boundary-rebaseline.md`
- `batch-cards/360-provider-live-read-execution-lane-validation.md`

Ready cards:

None.

## Acceptance Criteria

- [x] Credential material remains absent from stored records and DTOs.
- [x] Provider network calls remain unimplemented and blocked.
- [x] The planned client boundary exposes capabilities and response shapes
  without hiding provider differences.
- [x] Stopped executor handoff records can be built from persisted live-read
  plans.
- [x] Tests prove sanitized response/error diagnostics with fixture data only.

## Current Slice

Closed:

- live-read execution contract deltas, provider capability records, stopped
  handoff records, fixture response/error records, and execution diagnostics
  are implemented without credential material, real provider reads, provider
  writes, task mutation, callback/interruption/recovery execution, or raw
  payload retention.

Next:

- continue with `g03/090` provider live-read smoke approval gate before any
  real provider network call.

## Stop Conditions

- Stop before real provider network calls.
- Stop before credential material resolution.
- Stop before provider writes, status/check writes, comments, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
