# 386 Provider Live Read Approved Smoke Evidence Builder

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../097-provider-live-read-approved-smoke-evidence-promotion.md`

## Purpose

Build approved smoke evidence records from stopped command smoke requests and
sanitized command result mappings.

## Acceptance Criteria

- [x] Ready inputs produce promoted selected-field evidence.
- [x] Missing approval or unready request blocks promotion.
- [x] Provider writes, task mutation, callbacks, interruption/recovery effects,
  and raw payload retention block promotion.
