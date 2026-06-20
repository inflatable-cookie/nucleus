# 101 Completion SCM Capture Preparation Persistence

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Persist completion SCM capture-preparation records so later control diagnostics
and driver dry runs can use durable evidence without executing SCM or forge
effects.

## Governing Refs

- `docs/roadmaps/g02/100-completion-scm-capture-preparation-records.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Persist sanitized capture-preparation plan items.
- [x] Read persisted preparation records deterministically.
- [x] Preserve unsupported and repair-required preparation states.
- [x] Rebuild preparation diagnostics from persisted records.
- [x] Keep SCM/forge/provider/callback/recovery effects gated.

## Execution Plan

- [x] Persistence record batch.
- [x] State API batch.
- [x] Duplicate and blocked-state batch.
- [x] Diagnostics source batch.
- [x] Validation and next-lane selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/469-completion-scm-capture-preparation-persistence-records.md`
- `batch-cards/470-completion-scm-capture-preparation-state-api.md`
- `batch-cards/471-completion-scm-capture-preparation-duplicate-repair.md`
- `batch-cards/472-completion-scm-capture-preparation-diagnostics-source.md`
- `batch-cards/473-completion-scm-capture-preparation-persistence-closeout.md`

## Acceptance Criteria

- [x] Preparation records persist sanitized refs, labels, statuses, and blockers.
- [x] Duplicate persistence is deterministic.
- [x] Unsupported and repair states remain visible.
- [x] Diagnostics can rebuild from persisted records.
- [x] No external effects execute.

## Closeout

Completion SCM capture-preparation records now persist sanitized refs, adapter
labels, workflow labels, plan statuses, blockers, and evidence refs. Reads are
stable, duplicates are deterministic, unsupported and repair-required plans
remain evidence, and diagnostics rebuild from persisted records.

Next lane: expose persisted preparation diagnostics through the read-only
control surface.
