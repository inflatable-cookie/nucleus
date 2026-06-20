# 097 Completion SCM Capture Admission

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Admit completion SCM capture requests from persisted readiness evidence without
executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/094-completion-to-scm-change-request-readiness.md`
- `docs/roadmaps/g02/095-completion-scm-readiness-control-integration.md`
- `docs/roadmaps/g02/096-live-evidence-task-state-history-persistence.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Define capture-admission requests from readiness refs.
- [x] Require persisted task-state history and ready completion SCM diagnostics.
- [x] Preserve adapter-neutral SCM terminology.
- [x] Keep capture/publish/review-request/merge execution gated.
- [x] Select the next lane from validated admission evidence.

## Execution Plan

- [x] Capture admission request batch.
- [x] Readiness ref validation batch.
- [x] Capture admission diagnostics batch.
- [x] Authority regression batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/449-completion-scm-capture-admission-request.md`
- `batch-cards/450-completion-scm-readiness-ref-validation.md`
- `batch-cards/451-completion-scm-capture-admission-diagnostics.md`
- `batch-cards/452-completion-scm-capture-authority-regressions.md`
- `batch-cards/453-completion-scm-capture-admission-closeout.md`

## Acceptance Criteria

- [x] Capture admission can be requested from readiness refs.
- [x] Missing/unsupported/repair readiness blocks capture admission.
- [x] Admission remains provider-neutral.
- [x] No SCM or forge effect executes.
- [x] Next lane is selected from evidence after validation.

## Closeout

Completion SCM capture admission now validates persisted-readiness refs,
blocks missing, unsupported, repair-required, mismatched, and effect-requesting
inputs, and exposes read-only admission diagnostics. It does not execute SCM,
forge, provider, callback, interruption, recovery, or raw-material effects.

Next lane: persist capture-admission records so later SCM capture preparation
can be driven from durable evidence.
