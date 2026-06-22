# 280 Provider Read-Intent Effigy Selector

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../074-provider-read-intent-nucleusd-query.md`

## Purpose

Expose provider read-intent CLI query through the root Effigy task surface.

## Acceptance Criteria

- [x] `server:query:provider-read-intent` selector exists.
- [x] Selector runs `cargo run -p nucleusd -- query provider-read-intent`.
- [x] Selector runs from repo root.
- [x] Selector output remains read-only and effect-free.
