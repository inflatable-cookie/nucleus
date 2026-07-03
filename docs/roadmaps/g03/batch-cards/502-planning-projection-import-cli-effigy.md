# 502 Planning Projection Import CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../117-planning-projection-import-admission.md`

## Purpose

Add optional read-only `nucleusd` and Effigy inspection for planning projection
import diagnostics if the server query surface is ready.

## Work

- [x] Add server query/control DTO support if needed.
- [x] Add a `nucleusd query` route for diagnostics.
- [x] Add an Effigy selector for the read-only query.
- [x] Add focused CLI rendering tests.

## Acceptance Criteria

- [x] The route reports sanitized counts and no-effect flags.
- [x] The route does not read raw payloads into output.
- [x] The route performs no apply, promotion, provider, SCM, forge, or UI
  effects.

## Evidence

- Added `PlanningProjectionImportDiagnosticsQuery` and read-only request
  handling.
- Added control-envelope request/response DTO support for planning projection
  import diagnostics.
- Added `nucleusd query planning-projection-import-diagnostics --project ...`.
- Added `effigy server:query:planning-projection-import-diagnostics`.
- Focused server and `nucleusd` tests pass for the new query and renderer.
