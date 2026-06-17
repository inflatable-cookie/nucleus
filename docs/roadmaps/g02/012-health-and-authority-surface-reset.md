# 012 Health And Authority Surface Reset

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Restore the repo health gate and reduce oversized authority surfaces before
the next implementation lane starts.

The next real work will touch client protocol, host authority, provider
runtime, and product workflow boundaries. That should not happen while doctor
is failing on oversized modules and while roadmap direction is split across
several "maybe next" options.

## Governing Refs

- `AGENTS.md`
- `docs/contracts/001-working-rules.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `.effigy/reports/doctor/scan-god-files.md`

## Goals

- [x] Split error-level god files into smaller Rust modules.
- [x] Keep behavior unchanged while reducing file size.
- [x] Split or redirect broad authority docs where current front doors are too
  large to govern new work cleanly.
- [x] Normalize roadmap front doors around one ordered G02 runway suite.
- [x] Make `effigy doctor` a meaningful health gate again.

## Execution Plan

- [x] Code health batch: split error-level Rust god files without behavior
  changes.
- [x] Server boundary batch: move durable authority sections out of broad
  server docs where focused contracts already exist.
- [x] Roadmap suite batch: make G02's next suite explicit and remove "maybe
  next" ambiguity.
- [x] Validation batch: run doctor, docs QA, targeted Rust tests, and workspace
  check.

## Ready Cards

- `batch-cards/037-error-god-file-module-splits.md` - completed
- `batch-cards/038-server-boundary-authority-split.md` - completed
- `batch-cards/039-g02-roadmap-suite-normalization.md` - completed
- `batch-cards/040-health-reset-validation.md` - completed

## Acceptance Criteria

- [x] `effigy doctor` no longer reports error-level god-file findings.
- [x] Codex protocol, task commands, control response DTOs, and request-handler
  tests are split into focused modules.
- [x] Large server authority content has a focused owner or clear redirect.
- [x] `docs/roadmaps/README.md` points at one active next task.
- [x] No provider process, UI panel, SCM mutation, or remote transport behavior
  is added in this milestone.

## Closeout

Completed 2026-06-17.

`effigy doctor` reports no error findings. It still reports 22 warning-level
oversized files; those are follow-on debt and should be handled only when they
line up with the next implementation lanes.

## Gate

Do not start live provider runtime or client transport implementation until
this health reset is complete.
