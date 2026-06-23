# 453 Planning Task Seed Record Selection

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../111-planning-artifact-task-seed-promotion.md`

## Purpose

Select the exact first planning artifact and task seed record shapes.

## Work

- [x] Name fields for planning artifact refs.
- [x] Name fields for task seed candidates.
- [x] Define review state and promotion readiness flags.
- [x] Define source refs and sanitization rules.

## Acceptance Criteria

- [x] Record shape can be implemented without UI or provider execution.
- [x] Promotion remains deferred unless explicitly selected later.

## Decision

Implement in `nucleus-engine`:

- planning artifact ids, kind, status, review state, and source refs
- task seed ids, source artifact refs, suggested task fields, blocking
  questions, context refs, and agent-readiness hints
- deterministic task seed candidate projection
- explicit `client_can_promote=false` and `task_creation_performed=false`

Do not implement storage, server query, or promotion commands in this card.
