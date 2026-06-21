# 013 Convergence Publication Command Boundary

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Describe Convergence-like publication commands and stopped request/handoff
records from ready publication preflight without creating snapshots, publishing,
or invoking a provider.

## Governing Refs

- `docs/roadmaps/g03/012-convergence-publication-admission.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Goals

- [x] Create provider-specific command descriptors from ready preflight.
- [x] Keep snapshot, publish, and review-publication descriptors separate.
- [x] Add stopped request records with stable idempotency identity.
- [x] Keep all execution effects false.

## Execution Plan

- [x] Command descriptor batch.
- [x] Stopped request batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/052-convergence-publication-command-descriptors.md`
- `batch-cards/053-convergence-publication-stopped-requests.md`
- `batch-cards/054-convergence-publication-command-closeout.md`

## Acceptance Criteria

- [x] Command descriptors only derive from ready Convergence publication
  preflight.
- [x] Blocked preflight cannot produce executable commands.
- [x] Stopped requests preserve idempotency refs and provider-stage refs.
- [x] No snapshot creation, publish execution, review publication, provider
  write, task mutation, callback, interruption, recovery, or raw-output effect
  is added.
