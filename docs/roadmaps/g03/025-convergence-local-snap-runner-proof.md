# 025 Convergence Local Snap Runner Proof

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Create a stopped runner proof over persisted local snap requests before any
actual `converge snap` command execution is allowed.

## Governing Refs

- `docs/roadmaps/g03/024-convergence-local-snap-request-persistence.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Derive local snap runner proof records from persisted requests.
- [ ] Preserve request, idempotency, admission, replay, task, repo, and
  authority refs.
- [ ] Add sanitized proof evidence without command output.
- [ ] Keep command execution and remote effects false.

## Execution Plan

- [ ] Runner proof batch.
- [ ] Sanitized evidence batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/088-convergence-local-snap-runner-proof-records.md`

Planned cards:

- `batch-cards/089-convergence-local-snap-runner-evidence.md`
- `batch-cards/090-convergence-local-snap-runner-proof-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Persisted local snap requests can produce runner proof records.
- [ ] Duplicate and blocked persistence cannot run.
- [ ] Evidence remains sanitized and contains no local command output.
- [ ] No command spawn, actual `converge snap`, object upload, publication,
  lane sync, bundle, approval, promotion, release, resolution publication,
  provider write, task mutation, callback, interruption, recovery, or raw
  output effect is added.
