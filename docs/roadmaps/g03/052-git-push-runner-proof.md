# 052 Git Push Runner Proof

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Implement the first explicit Git push runner proof from existing admitted push
preflight records.

This lane may plan and persist push execution only. It must not open pull
requests, call forge APIs, run provider writes, answer callbacks,
interrupt/recover harness sessions, mutate task state, retain raw output, or
expand UI/remote transport.

## Governing Refs

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/006-git-push-admission.md`
- `docs/roadmaps/g03/051-git-commit-runner-proof.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Add push runner authority from existing ready preflight records.
- [x] Add a constrained push command adapter.
- [x] Persist sanitized push runner outcomes and evidence.
- [x] Expose read-only diagnostics/control DTOs for push runner state.
- [x] Keep warning-sized files split when touched.

## Execution Plan

- [x] Push runner authority records.
- [x] Push command adapter.
- [x] Sanitized outcome persistence.
- [x] Diagnostics/control integration.
- [x] Validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/173-git-push-runner-authority-records.md`
- `batch-cards/174-git-push-runner-command-adapter.md`
- `batch-cards/175-git-push-runner-outcome-persistence.md`
- `batch-cards/176-git-push-runner-diagnostics-control.md`
- `batch-cards/177-git-push-runner-validation-closeout.md`

## Acceptance Criteria

- [x] Runner execution is admitted only from existing ready preflight records
  and explicit operator push intent.
- [x] Remote target material is represented as sanitized remote/branch refs.
- [x] Command adapter builds executable argv without shell passthrough.
- [x] Outcomes retain sanitized ids, statuses, counts, remote refs, path refs
  by policy, and evidence refs only.
- [x] PR, forge, provider, callback, interruption, recovery, task mutation,
  UI/remote transport expansion, and raw-output retention remain blocked.
- [x] `effigy doctor` remains error-free or a blocker is recorded.

## Closeout

The push runner proof now reaches sanitized persistence and read-only control
DTOs from existing admitted push preflight records.

Next lane:

- compile the Git pull-request runner proof

Reason:

- push execution now has authority, command adapter, outcome persistence, and
  diagnostics
- PR execution is already separated in the Git change-request sequence
- forge/provider network effects should remain explicit and independently
  admitted
