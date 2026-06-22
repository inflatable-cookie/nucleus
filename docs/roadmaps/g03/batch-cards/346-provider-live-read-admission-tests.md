# 346 Provider Live Read Admission Tests

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../088-provider-live-read-admission-gate.md`

## Purpose

Prove live-read admission behavior with fixtures.

## Acceptance Criteria

- [x] Tests cover ready read-only admission.
- [x] Tests cover missing refs and unsupported/mutating operation families.
- [x] Tests cover blocked credential material, provider payload, raw payload
  retention, provider write, callback, interruption, recovery, and task
  mutation requests.
- [x] Tests prove no provider network call is executed.
