# 525 Research Run Brief Storage Codec

Status: planned
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Add JSON storage records for research run briefs.

## Work

- [ ] Add storage records for research run briefs, questions, source refs,
  observation refs, synthesis refs, confidence, coverage, and promotion target
  refs.
- [ ] Add encode/decode tests.
- [ ] Keep projection/apply, promotion, execution, and raw source retention
  deferred.

## Acceptance Criteria

- [ ] Codec round trips stable ids, project refs, brief, scope, status,
  questions, source refs, observation refs, synthesis refs, and promotion
  target refs.
- [ ] Storage excludes raw browser caches, copyrighted source payloads, raw
  transcripts, provider payloads, private notes, credentials, and
  secret-bearing files.
- [ ] No crawler, browser, provider, task, projection, UI, or SCM/forge effect
  is added.
