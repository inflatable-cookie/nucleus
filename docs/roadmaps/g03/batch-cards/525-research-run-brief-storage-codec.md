# 525 Research Run Brief Storage Codec

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../120-deep-research-run-brief-foundation.md`

## Purpose

Add JSON storage records for research run briefs.

## Work

- [x] Add storage records for research run briefs, questions, source refs,
  observation refs, synthesis refs, confidence, coverage, and promotion target
  refs.
- [x] Add encode/decode tests.
- [x] Keep projection/apply, promotion, execution, and raw source retention
  deferred.

## Acceptance Criteria

- [x] Codec round trips stable ids, project refs, brief, scope, status,
  questions, source refs, observation refs, synthesis refs, and promotion
  target refs.
- [x] Storage excludes raw browser caches, copyrighted source payloads, raw
  transcripts, provider payloads, private notes, credentials, and
  secret-bearing files.
- [x] No crawler, browser, provider, task, projection, UI, or SCM/forge effect
  is added.

## Evidence

- `cargo test -p nucleus-research`
