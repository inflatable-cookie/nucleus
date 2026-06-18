# 029 Health And Module Boundary Reset

Status: completed
Owner: Tom
Updated: 2026-06-18

## Purpose

Clear the red doctor gate and reduce module accretion before task-backed
runtime work expands command policy, server DTOs, and desktop proof surfaces.

## Governing Refs

- `docs/logs/2026-06-18-stocktake.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/contracts/001-working-rules.md`
- `AGENTS.md`

## Goals

- [x] Split the high `scan.god-files` finding.
- [x] Keep Rust modules small and named by responsibility.
- [x] Identify warning-sized files that should not grow in the next runway.
- [x] Restore `effigy doctor` or document any residual non-blocking warnings.

## Execution Plan

- [x] Doctor triage batch: capture current scan findings and split targets.
- [x] Actual god-file split batch: split high-pressure files into focused modules.
- [x] Server/desktop pressure batch: document files that must not absorb more
  task-agent workflow code.
- [x] Validation batch: run doctor, focused Rust tests, and docs gates.

## Batch Cards

Completed cards:

- `batch-cards/124-doctor-god-file-triage.md`
- `batch-cards/125-god-file-module-splits.md`
- `batch-cards/126-server-dto-module-pressure-review.md`
- `batch-cards/127-desktop-proof-surface-module-pressure-review.md`
- `batch-cards/128-health-reset-validation.md`

## Acceptance Criteria

- [x] `effigy doctor` no longer fails on the high god-file finding, or the
  remaining issue is explicitly rehomed with evidence.
- [x] Actual high-pressure responsibilities are split into named files.
- [x] Next runtime work has clear module boundaries.

## Result

`effigy doctor` exits successfully with only warning-level god-file findings:
33 warnings and 0 errors. The stale command-policy split expectation was
superseded by current doctor evidence; the actual split covered native
harness, engine, server, DTO, and desktop proof surfaces.

## Gate

Do not start task-backed runtime work while the command-policy god-file remains
red.
