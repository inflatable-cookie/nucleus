# 565 Accepted Memory Projection Policy Model

Status: ready
Owner: Tom
Updated: 2026-07-05
Milestone: `../129-accepted-memory-projection-policy-gate.md`

## Purpose

Add the first server-side policy model for deciding whether accepted memories
may be projected into project-managed files.

## Work

- [ ] Add accepted-memory projection policy types in small focused modules.
- [ ] Classify records as projectable, local-only, blocked, or
  review-required.
- [ ] Model blocker reasons for sensitivity, retention, status, supersession,
  missing review evidence, missing project scope, and unsafe export intent.
- [ ] Keep the model pure: no file writes, no SCM effects, no embeddings, no
  provider sync, no task mutation, and no UI.

## Acceptance Criteria

- [ ] Focused tests cover eligible project memories.
- [ ] Focused tests cover user-private, restricted, secret-adjacent,
  local-only, stale, superseded, archived, and missing-review blockers.
- [ ] The model uses accepted-memory ids and refs, not provider ids or file
  paths, as authority.
