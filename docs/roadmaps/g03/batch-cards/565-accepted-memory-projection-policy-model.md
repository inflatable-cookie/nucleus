# 565 Accepted Memory Projection Policy Model

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Add the first server-side policy model for deciding whether accepted memories
may be projected into project-managed files.

## Work

- [x] Add accepted-memory projection policy types in small focused modules.
- [x] Classify records as projectable, local-only, blocked, or
  review-required.
- [x] Model blocker reasons for sensitivity, retention, status, supersession,
  missing review evidence, missing project scope, and unsafe export intent.
- [x] Keep the model pure: no file writes, no SCM effects, no embeddings, no
  provider sync, no task mutation, and no UI.

## Acceptance Criteria

- [x] Focused tests cover eligible project memories.
- [x] Focused tests cover user-private, restricted, secret-adjacent,
  local-only, stale, superseded, archived, and missing-review blockers.
- [x] The model uses accepted-memory ids and refs, not provider ids or file
  paths, as authority.

## Result

Accepted-memory projection policy now classifies accepted-memory storage
records as projectable, local-only, review-required, or blocked.

The policy is pure and no-effect. It blocks or defers projection for
non-project scope, out-of-scope projects, user-private and restricted
sensitivity, secret-adjacent sensitivity, non-project-context retention,
non-accepted statuses, superseded records, missing review evidence, and unsafe
memory ids before any deterministic path is derived.
