# 107 SCM Capture Dry Run Execution Persistence

Status: active
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist SCM capture dry-run execution admissions and receipts so later control
diagnostics and adapter-specific driver proofs can replay dry-run evidence
without rerunning SCM effects.

## Governing Refs

- `docs/roadmaps/g02/104-scm-capture-dry-run-planning-persistence.md`
- `docs/roadmaps/g02/105-scm-capture-dry-run-control-integration.md`
- `docs/roadmaps/g02/106-scm-capture-dry-run-execution-gate.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [ ] Persist sanitized dry-run execution receipts.
- [ ] Read persisted dry-run execution receipts in deterministic order.
- [ ] Preserve terminal and blocked outcomes as evidence.
- [ ] Rebuild dry-run execution diagnostics from persisted receipts.
- [ ] Keep capture, publish, forge, provider, callback, interruption, recovery,
  and raw-output authority blocked.

## Execution Plan

- [ ] Dry-run execution persistence record batch.
- [ ] State API and ordering batch.
- [ ] Duplicate and blocked-outcome regression batch.
- [ ] Diagnostics-source batch.
- [ ] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

- `batch-cards/499-scm-capture-dry-run-execution-persistence-records.md`

Planned cards:

- `batch-cards/500-scm-capture-dry-run-execution-state-api.md`
- `batch-cards/501-scm-capture-dry-run-execution-duplicate-blocked.md`
- `batch-cards/502-scm-capture-dry-run-execution-diagnostics-source.md`
- `batch-cards/503-scm-capture-dry-run-execution-persistence-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Dry-run execution receipts persist as sanitized artifact metadata.
- [ ] Duplicate writes are deterministic no-ops.
- [ ] Blocked, failed, timed-out, and repair-required outcomes remain visible.
- [ ] Diagnostics rebuild from persisted receipts.
- [ ] No raw SCM output is retained in durable records.
