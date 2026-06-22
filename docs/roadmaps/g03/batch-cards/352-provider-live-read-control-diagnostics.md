# 352 Provider Live Read Control Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../088-provider-live-read-admission-gate.md`

## Purpose

Expose provider live-read gate diagnostics through read-only control surfaces.

## Acceptance Criteria

- [x] Diagnostics DTOs expose counts, blocker counts, evidence refs, and
  no-effect flags.
- [x] Request handler and serialized envelope surfaces remain read-only if
  added.
- [x] Clients cannot trigger provider network reads through diagnostics.
- [x] Sanitization tests cover credential and raw payload forbidden tokens.
