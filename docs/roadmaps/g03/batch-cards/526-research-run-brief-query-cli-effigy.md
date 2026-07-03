# 526 Research Run Brief Query CLI Effigy

Status: planned
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Expose read-only research run brief inspection if storage is ready.

## Work

- [ ] Add a server query shape for research run briefs or diagnostics.
- [ ] Add control DTO support.
- [ ] Add `nucleusd query` rendering.
- [ ] Add an Effigy selector.
- [ ] Add focused tests.

## Acceptance Criteria

- [ ] Query reports sanitized counts, statuses, scopes, question counts, source
  counts, observation refs, synthesis refs, and promotion target refs.
- [ ] Raw source payloads, raw transcripts, provider payloads, secret material,
  private notes, and browser caches are not exposed.
- [ ] No crawler, browser, provider, task, SCM, forge, embedding, projection,
  promotion, or UI effects are added.
