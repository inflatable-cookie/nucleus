# 098 Completion SCM Capture Admission Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist completion SCM capture-admission records so later capture preparation
can be driven from durable evidence without executing SCM or forge effects.

## Governing Refs

- `docs/roadmaps/g02/097-completion-scm-capture-admission.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist sanitized capture-admission records.
- [x] Read persisted capture admissions deterministically.
- [x] Preserve duplicate and blocked admission evidence.
- [x] Expose persisted capture-admission diagnostics.
- [x] Keep capture, publish, review-request, merge, provider, callback, and recovery effects gated.

## Execution Plan

- [x] Persistence record batch.
- [x] State API batch.
- [x] Duplicate and blocked-admission batch.
- [x] Diagnostics source integration batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/454-completion-scm-capture-admission-persistence-records.md`
- `batch-cards/455-completion-scm-capture-admission-state-api.md`
- `batch-cards/456-completion-scm-capture-duplicate-blocked-regressions.md`
- `batch-cards/457-completion-scm-capture-diagnostics-source.md`
- `batch-cards/458-completion-scm-capture-persistence-closeout.md`

## Acceptance Criteria

- [x] Capture admissions persist sanitized refs and blockers.
- [x] Duplicate admission persistence is deterministic.
- [x] Blocked admissions remain visible.
- [x] Diagnostics can read persisted admissions.
- [x] No external effects execute.

## Closeout

Completion SCM capture admissions now persist sanitized refs, statuses,
admission blockers, and persistence blockers. Reads are stable, duplicates are
deterministic, blocked admissions remain evidence, and diagnostics can rebuild
from persisted records without executing external effects.

Next lane: route persisted capture-admission diagnostics through the read-only
control surface.
