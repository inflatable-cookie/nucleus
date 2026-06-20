# 378 Next Product Lane Selection

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../082-task-backed-live-workflow-closeout.md`

## Purpose

Select the next product lane after task-backed live workflow closeout.

## Scope

- Compare next viable lanes: SCM execution, steward automation, Effigy portal,
  client transport, workspace panels, or planning/research/memory.
- Use evidence from implementation and gap indexes.
- Produce one ready next milestone or a paused planning gate.

## Acceptance Criteria

- [x] Next lane is selected from evidence.
- [x] Roadmap front doors have one clear next task.
- [x] Generation rollover is considered only if justified.
- [x] Validation passes or blockers are recorded.

## Result

Selected `083 Durable Codex Live Smoke Execution` as the next lane. G02 remains
appropriate because this continues the same orchestration/runtime proof rather
than switching product gears.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
