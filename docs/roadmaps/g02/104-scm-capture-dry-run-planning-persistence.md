# 104 SCM Capture Dry Run Planning Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist SCM capture dry-run planning records so later control diagnostics and
driver execution gates can read stable evidence without running SCM or forge
effects.

## Governing Refs

- `docs/roadmaps/g02/101-completion-scm-capture-preparation-persistence.md`
- `docs/roadmaps/g02/102-completion-scm-capture-preparation-control-integration.md`
- `docs/roadmaps/g02/103-scm-capture-driver-dry-run-planning.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist sanitized dry-run plan records.
- [x] Read persisted dry-run plans in deterministic order.
- [x] Preserve skipped, unsupported, and repair-required evidence.
- [x] Rebuild dry-run planning diagnostics from persisted records.
- [x] Keep SCM, forge, provider, callback, interruption, recovery, and raw
  material effects blocked.

## Execution Plan

- [x] Dry-run persistence record batch.
- [x] State API and ordering batch.
- [x] Duplicate, repair, and blocked-state batch.
- [x] Diagnostics-source batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/484-scm-capture-dry-run-persistence-records.md`
- `batch-cards/485-scm-capture-dry-run-state-api.md`
- `batch-cards/486-scm-capture-dry-run-duplicate-repair-regressions.md`
- `batch-cards/487-scm-capture-dry-run-diagnostics-source.md`
- `batch-cards/488-scm-capture-dry-run-persistence-closeout.md`

## Acceptance Criteria

- [x] Ready dry-run plans persist as sanitized artifact metadata.
- [x] Unsupported and repair-required plans remain visible as evidence.
- [x] Duplicate writes are deterministic no-ops.
- [x] Diagnostics can be rebuilt from persisted dry-run planning records.
- [x] No SCM or forge effect executes.
