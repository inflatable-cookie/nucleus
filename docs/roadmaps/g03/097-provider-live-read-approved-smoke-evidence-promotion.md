# 097 Provider Live Read Approved Smoke Evidence Promotion

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Promote the approved read-only `gh repo view octocat/Hello-World` smoke result
into server-owned executor evidence records.

This lane should record the observed selected-field repository metadata as a
sanitized command-runner evidence path. It must not add automatic provider
execution, UI-triggered provider reads, provider writes, raw payload retention,
credential material storage, task mutation, callbacks, or interruption/recovery
execution.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/095-provider-live-read-executor-command-runner-handoff.md`
- `docs/roadmaps/g03/096-provider-live-read-command-runner-smoke-approval.md`

## Goals

- [x] Add approved smoke evidence records for selected-field repository
  metadata.
- [x] Link command smoke request, handoff, sanitized output, and receipt refs.
- [x] Add diagnostics for approved smoke evidence promotion.
- [x] Keep automatic provider execution and all write/effect authority blocked.

## Execution Plan

- [x] Add approved smoke evidence type surface.
- [x] Add record builder and blockers for missing or effectful evidence.
- [x] Add diagnostics and focused tests.
- [x] Validate and stop before broader provider read fan-out.

## Batch Cards

Completed cards:

- `batch-cards/385-provider-live-read-approved-smoke-evidence-types.md`
- `batch-cards/386-provider-live-read-approved-smoke-evidence-builder.md`
- `batch-cards/387-provider-live-read-approved-smoke-evidence-diagnostics.md`
- `batch-cards/388-provider-live-read-approved-smoke-evidence-validation.md`

## Acceptance Criteria

- [x] Evidence records reference command smoke request, handoff, output, and
  receipt ids.
- [x] Evidence records contain selected fields only.
- [x] Missing approval, failed mapping, raw payload retention, provider writes,
  task mutation, callbacks, and interruption/recovery execution block
  promotion.
- [x] Diagnostics expose counts and no-effect flags.

## Current Slice

Completed:

- implemented cards 385-388 as one evidence promotion batch.
- next lane should expose promoted evidence through read-only query/control
  diagnostics before more provider read fan-out.

## Stop Conditions

- Stop before automatic provider command execution.
- Stop before UI-triggered provider reads.
- Stop before provider writes, comments, status/check writes, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before storing raw provider stdout/stderr, headers, response bodies, or
  credential material.
