# 092 Provider Live Read Smoke Closeout And Executor Selection

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Close the first approved live-read smoke and choose the next implementation
lane.

The smoke proved an operator-approved read-only provider request through `gh`.
It did not prove a Nucleus-owned provider executor.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/091-provider-live-read-smoke-operator-approval-checkpoint.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Record what the live-read smoke proved and did not prove.
- [x] Keep raw provider payload and credential material out of persisted docs.
- [x] Decide whether the next lane is a server-owned live-read executor.
- [x] Keep provider writes and task mutation blocked.

## Execution Plan

- [x] Promote smoke evidence into architecture and gap surfaces.
- [x] Compare ad hoc `gh` smoke with the existing stopped Nucleus records.
- [x] Select the next lane without silently granting broad provider authority.
- [x] Validate docs, Rust, doctor, and next-task placement.

## Batch Cards

Completed cards:

- `batch-cards/365-provider-live-read-smoke-evidence-promotion.md`
- `batch-cards/366-provider-live-read-executor-gap-selection.md`
- `batch-cards/367-provider-live-read-smoke-closeout-validation.md`

Ready cards:

None.

## Acceptance Criteria

- [x] Smoke evidence is represented as sanitized docs only.
- [x] The remaining executor gap is explicit.
- [x] Next task does not imply provider writes, task mutation, callbacks,
  interruption/recovery execution, or raw payload retention.
- [x] Validation passes.

## Current Slice

Closed:

- manual provider smoke evidence is promoted and the next lane is a
  server-owned read-only live-read executor.

Next:

- continue with `g03/093` server-owned provider live-read executor lane.

## Stop Conditions

- Stop before provider writes, status/check writes, comments, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
