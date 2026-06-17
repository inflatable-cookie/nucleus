# 138 Reassess Task Create Edit Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether task create/edit can be planned.

## Scope

- Check editable task input contract.
- Check full task storage round-trip behavior.
- Check validation and revision UX.
- Decide next task mutation lane.

## Out Of Scope

- Implementing create/edit UI.
- Agent assignment.
- Runtime execution.

## Promotion Targets

- `docs/roadmaps/g01`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/007-server-boundary-contract.md`

## Acceptance Criteria

- Create/edit readiness is explicit.
- Missing task authoring contract remains visible if still blocked.

## Result

Task create/edit is not ready.

The project has transition commands and a display DTO path, but it still lacks:

- editable task input DTOs
- full task storage round-trip semantics
- create/update validation rules
- acceptance criteria editing rules
- assignment-readiness editing rules
- revision conflict UX for edit forms

Next lane: define task authoring and edit semantics before adding create/edit
UI.
