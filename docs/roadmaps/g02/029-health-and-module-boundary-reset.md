# 029 Health And Module Boundary Reset

Status: active
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

- [ ] Split the high `scan.god-files` finding.
- [ ] Keep Rust modules small and named by responsibility.
- [ ] Identify warning-sized files that should not grow in the next runway.
- [ ] Restore `effigy doctor` or document any residual non-blocking warnings.

## Execution Plan

- [ ] Doctor triage batch: capture current scan findings and split targets.
- [ ] Command-policy split batch: break `storage_codec.rs` into focused modules.
- [ ] Server/desktop pressure batch: document files that must not absorb more
  task-agent workflow code.
- [ ] Validation batch: run doctor, focused Rust tests, and docs gates.

## Batch Cards

Ready cards:

- `batch-cards/124-doctor-god-file-triage.md`

Planned cards:

- `batch-cards/125-command-policy-storage-codec-split.md`
- `batch-cards/126-server-dto-module-pressure-review.md`
- `batch-cards/127-desktop-proof-surface-module-pressure-review.md`
- `batch-cards/128-health-reset-validation.md`

## Acceptance Criteria

- [ ] `effigy doctor` no longer fails on the high god-file finding, or the
  remaining issue is explicitly rehomed with evidence.
- [ ] Command policy codec responsibilities are split into named files.
- [ ] Next runtime work has clear module boundaries.

## Gate

Do not start task-backed runtime work while the command-policy god-file remains
red.
