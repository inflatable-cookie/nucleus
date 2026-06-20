# 081 Provider Observability Diagnostics

Status: planned
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

- [ ] Define sanitized provider trace span records.
- [ ] Define support bundle manifests without raw payloads.
- [ ] Expose observability diagnostics DTOs.
- [ ] Connect provider health findings to Effigy/doctor evidence where useful.
- [ ] Keep diagnostics read-only.

## Execution Plan

- [ ] Trace batch.
- [ ] Support bundle batch.
- [ ] Diagnostics DTO batch.
- [ ] Health integration batch.
- [ ] Closeout batch.

## Batch Cards

Ready cards:

None.

Planned cards:

- `batch-cards/369-provider-trace-span-records.md`
- `batch-cards/370-provider-support-bundle-manifest.md`
- `batch-cards/371-provider-observability-diagnostics-dto.md`
- `batch-cards/372-provider-health-doctor-integration.md`
- `batch-cards/373-provider-observability-validation-closeout.md`

Completed cards:

None.

## Acceptance Criteria

- [ ] Provider runtime failures can be diagnosed from sanitized evidence.
- [ ] Support bundles enumerate evidence refs, not raw material.
- [ ] Diagnostics grant no provider or task authority.
- [ ] Validation passes or blockers are recorded.
