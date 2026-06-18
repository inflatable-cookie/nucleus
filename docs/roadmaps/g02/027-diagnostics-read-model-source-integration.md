# 027 Diagnostics Read Model Source Integration

Status: planned
Owner: Tom
Updated: 2026-06-18

## Purpose

Connect diagnostics queries to real server-side source records where those
records already exist.

This milestone should not create new durable stores just to make every
diagnostic populated. Missing source domains should return explicit empty or
unsupported diagnostics.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Goals

- [ ] Source steward diagnostics from available steward command records.
- [ ] Source Effigy diagnostics from native harness/Effigy records where
  available.
- [ ] Source management sync diagnostics from engine sync records where
  available.
- [ ] Source SCM diagnostics from session and work-item linkage records where
  available.

## Execution Plan

- [ ] Steward source batch: connect command/proposal records or return explicit
  empty state.
- [ ] Effigy source batch: connect integration and health records or return
  explicit empty state.
- [ ] Sync source batch: connect projection sync records or return explicit
  empty state.
- [ ] SCM source batch: connect session/link records or return explicit empty
  state.
- [ ] Validation batch: prove missing source domains are explicit.

## Batch Cards

Planned cards:

- `batch-cards/114-steward-diagnostics-source-records.md`
- `batch-cards/115-effigy-diagnostics-source-records.md`
- `batch-cards/116-sync-diagnostics-source-records.md`
- `batch-cards/117-scm-diagnostics-source-records.md`
- `batch-cards/118-diagnostics-source-integration-validation.md`

## Acceptance Criteria

- [ ] Diagnostics use real server-side records when available.
- [ ] Empty or unsupported diagnostics are explicit.
- [ ] Query execution does not create or mutate domain records.

## Gate

Do not add broad persistence schemas before the source domain contract exists.
