# 237 Codex Observation Event Store Linkage

Status: planned
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Link accepted Codex observations to orchestration-owned event-store records.

## Scope

- Map accepted canonical runtime events into event-store envelopes.
- Preserve source ingestion ids and provider refs.
- Link receipt projections for wait, cancellation, failure, and completion
  observations.
- Do not replay provider actions or spawn processes.

## Acceptance Criteria

- Accepted observations have stable event-store refs.
- Runtime receipt refs remain sanitized and replay-safe.
- Projection replay reads records and does not re-run provider work.

## Validation

- targeted orchestration/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if event-store ordering cannot be made deterministic for accepted
  observations.
