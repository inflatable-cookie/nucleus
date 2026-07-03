# 538 Planning Import Apply Readiness Model

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../123-planning-projection-import-review-apply.md`

## Purpose

Model pure apply-readiness over reviewed planning projection import records.

## Work

- [x] Add read-only readiness classes for ready, blocked, duplicate no-op,
  stale, conflict, unsupported, and repair-required states.
- [x] Map reviewed import admissions and staged conflicts into readiness
  entries.
- [x] Keep the model pure and side-effect-free.

## Acceptance Criteria

- [x] Readiness entries identify why apply is blocked.
- [x] Ready entries cite sanitized candidate/admission/evidence refs.
- [x] No active planning records are mutated.
