# 103 SCM Capture Driver Dry Run Planning

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Define SCM capture driver dry-run planning records from persisted preparation
state without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/100-completion-scm-capture-preparation-records.md`
- `docs/roadmaps/g02/101-completion-scm-capture-preparation-persistence.md`
- `docs/roadmaps/g02/102-completion-scm-capture-preparation-control-integration.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define dry-run planning records from persisted preparation records.
- [x] Keep adapter-specific planning descriptive.
- [x] Preserve Git and non-Git SCM vocabulary separation.
- [x] Keep SCM/forge execution gated.
- [x] Select the next lane from validated evidence.

## Execution Plan

- [x] Dry-run planning candidate batch.
- [x] Adapter capability mapping batch.
- [x] Dry-run diagnostics batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/479-scm-capture-dry-run-plan-candidates.md`
- `batch-cards/480-scm-capture-dry-run-adapter-capabilities.md`
- `batch-cards/481-scm-capture-dry-run-diagnostics.md`
- `batch-cards/482-scm-capture-dry-run-authority.md`
- `batch-cards/483-scm-capture-dry-run-planning-closeout.md`

## Acceptance Criteria

- [x] Persisted ready preparation records create dry-run plan candidates.
- [x] Unsupported and repair-required preparation records stay visible.
- [x] Core records avoid Git-only terminology.
- [x] No SCM or forge effect executes.
- [x] Next lane is selected from evidence after validation.
