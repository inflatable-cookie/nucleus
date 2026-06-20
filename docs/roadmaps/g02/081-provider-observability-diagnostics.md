# 081 Provider Observability Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Expose provider runtime observability through sanitized traces, support bundles,
health evidence, and read-only diagnostics.

## Governing Refs

- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/080-provider-runtime-hardening.md`

## Goals

- [x] Define sanitized provider trace span records.
- [x] Define support bundle manifests without raw payloads.
- [x] Expose observability diagnostics DTOs.
- [x] Connect provider health findings to Effigy/doctor evidence where useful.
- [x] Keep diagnostics read-only.

## Execution Plan

- [x] Trace batch.
- [x] Support bundle batch.
- [x] Diagnostics DTO batch.
- [x] Health integration batch.
- [x] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/369-provider-trace-span-records.md`
- `batch-cards/370-provider-support-bundle-manifest.md`
- `batch-cards/371-provider-observability-diagnostics-dto.md`
- `batch-cards/372-provider-health-doctor-integration.md`
- `batch-cards/373-provider-observability-validation-closeout.md`

## Acceptance Criteria

- [x] Provider runtime failures can be diagnosed from sanitized evidence.
- [x] Support bundles enumerate evidence refs, not raw material.
- [x] Diagnostics grant no provider or task authority.
- [x] Validation passes or blockers are recorded.
