# 270 Provider Read-Intent Contract Delta

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../072-provider-read-intent-boundary-rebaseline.md`

## Purpose

Record the provider read-intent control and serialized-envelope rule in the
provider auth/forge execution contract.

## Acceptance Criteria

- [x] Contract separates in-process control support from serialized DTO
  support.
- [x] Contract defines allowed read-intent DTO material.
- [x] Contract blocks credential material and raw provider payloads.
- [x] Contract makes clear that read-intent DTOs do not grant provider effects.
