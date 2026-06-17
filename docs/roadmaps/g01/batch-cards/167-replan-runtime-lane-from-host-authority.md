# 167 Replan Runtime Lane From Host Authority

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Replan runtime work after the engine host authority correction.

## Scope

- Decide whether process-supervisor work should resume.
- Identify required host/authority-map types first.
- Set the next ready card.

## Out Of Scope

- Runtime implementation.
- Crate rename.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- Paused runtime lane is either resumed, superseded, or narrowed.
- Next task is not based on stale server-first assumptions.

## Closeout

- Process-supervisor work remains paused.
- Next lane is host authority-map vocabulary, because execution authority must
  be representable before runtime supervision resumes.
