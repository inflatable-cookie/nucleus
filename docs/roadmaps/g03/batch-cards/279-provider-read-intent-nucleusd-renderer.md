# 279 Provider Read-Intent Nucleusd Renderer

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../074-provider-read-intent-nucleusd-query.md`

## Purpose

Render provider read-intent DTO results as stable sanitized CLI summary lines.

## Acceptance Criteria

- [x] Renderer prints domain, query id, projection id, counts, and source
  counts.
- [x] Renderer prints explicit no-effect flags.
- [x] Renderer can print sanitized entry refs when present.
- [x] Renderer test proves obvious raw provider/credential material is absent.
