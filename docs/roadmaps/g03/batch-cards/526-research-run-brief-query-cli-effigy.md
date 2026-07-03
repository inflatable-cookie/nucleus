# 526 Research Run Brief Query CLI Effigy

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Expose read-only research run brief inspection if storage is ready.

## Work

- [x] Add a server query shape for research run briefs or diagnostics.
- [x] Add control DTO support.
- [x] Add `nucleusd query` rendering.
- [x] Add an Effigy selector.
- [x] Add focused tests.

## Acceptance Criteria

- [x] Query reports sanitized counts, statuses, scopes, question counts, source
  counts, observation refs, synthesis refs, and promotion target refs.
- [x] Raw source payloads, raw transcripts, provider payloads, secret material,
  private notes, and browser caches are not exposed.
- [x] No crawler, browser, provider, task, SCM, forge, embedding, projection,
  promotion, or UI effects are added.

## Evidence

- `cargo test -p nucleus-server research_run_briefs -- --nocapture`
- `cargo test -p nucleusd research_run_briefs -- --nocapture`
- `effigy server:query:research-run-briefs`
