# 391 Provider Live Read Approved Smoke Evidence Nucleusd Effigy Query

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../098-provider-live-read-approved-smoke-evidence-control-surface.md`

## Purpose

Expose approved smoke evidence diagnostics through `nucleusd` and Effigy.

## Acceptance Criteria

- [x] `nucleusd query provider-live-read-smoke-evidence` renders sanitized
  diagnostics.
- [x] Effigy has a matching root selector.
- [x] CLI tests cover the new query domain.
