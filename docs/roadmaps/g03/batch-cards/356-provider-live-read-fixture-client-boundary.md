# 356 Provider Live Read Fixture Client Boundary

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../089-provider-live-read-execution-contract-and-adapter-boundary.md`

## Purpose

Add a fixture-only provider read client boundary for typed requests and
sanitized responses.

## Acceptance Criteria

- [x] Traits or records describe provider read request, response, error, and
  capability shapes.
- [x] Fixture clients cannot perform network I/O.
- [x] Provider differences remain explicit in capability records.
- [x] Tests prove no credential material or raw payload fields are exposed.
