# 022 Convergence Local Snap Admission

Status: active
Owner: Tom
Updated: 2026-06-21

## Purpose

Define the first effect-specific Convergence admission gate for local snap
creation without object upload, publication, lane sync, promotion, or release.

## Governing Refs

- `docs/roadmaps/g03/021-convergence-runner-replay-boundary.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`

## Goals

- [ ] Admit local snap creation only when source and execution authority are
  ready.
- [ ] Keep remote Convergence effects blocked.
- [ ] Preserve replay refs and task/repo identity.
- [ ] Add diagnostics for ready, blocked, duplicate, and unsupported snap
  admissions.

## Execution Plan

- [ ] Local snap admission batch.
- [ ] Local snap diagnostics batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

- `batch-cards/079-convergence-local-snap-admission-records.md`

Planned cards:

- `batch-cards/080-convergence-local-snap-admission-diagnostics.md`
- `batch-cards/081-convergence-local-snap-admission-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Local snap admission derives from replay records and authority inputs.
- [ ] Remote effects remain blocked and separate.
- [ ] Duplicate admission ids are deterministic no-ops.
- [ ] No actual `converge snap`, object upload, publication, lane sync,
  bundle, approval, promotion, release, resolution publication, provider write,
  task mutation, callback, interruption, recovery, or raw-output effect is
  added.
