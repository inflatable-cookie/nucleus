# 104 Provider Live Read Second Family Stopped Request

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Represent the selected second provider read family as stopped records before
any live execution.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/103-provider-live-read-second-family-selection.md`

## Goals

- [x] Add target, authority checklist, and stopped request records for the
  selected family.
- [x] Add diagnostics and control DTOs as needed.
- [x] Keep live execution blocked.

## Execution Plan

- [x] Implement record vocabulary.
- [x] Add blockers and diagnostics.
- [x] Add focused tests.
- [x] Validate and pause at approval.

## Batch Cards

Completed cards:

- `batch-cards/413-provider-live-read-second-family-target-records.md`
- `batch-cards/414-provider-live-read-second-family-authority-checklist.md`
- `batch-cards/415-provider-live-read-second-family-stopped-request.md`
- `batch-cards/416-provider-live-read-second-family-stopped-validation.md`

## Acceptance Criteria

- [x] Stopped request records exist for the selected family.
- [x] No provider command is executed.
- [x] Blockers cover credential, network, write, task, callback, recovery, and
  raw payload risks.

## Current Slice

Completed:

- added status/check smoke target, authority checklist, stopped request, and
  diagnostics records.
- modeled the selected `gh pr checks` command shape with selected JSON fields.
- validated approval-required, stopped-after-approval, and blocked-effect
  paths without provider command execution.
