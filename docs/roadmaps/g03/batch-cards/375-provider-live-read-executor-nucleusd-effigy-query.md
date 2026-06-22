# 375 Provider Live Read Executor Nucleusd Effigy Query

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../094-provider-live-read-executor-control-surface.md`

## Purpose

Expose provider live-read executor diagnostics through `nucleusd query` and the
root Effigy task surface.

## Acceptance Criteria

- [x] `nucleusd query` can render the read-only executor diagnostics.
- [x] Effigy has a root selector for the query if the command shape is stable.
- [x] The query performs no provider network call by itself.
