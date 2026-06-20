# 378 Next Product Lane Selection

Status: planned
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

- [ ] Next lane is selected from evidence.
- [ ] Roadmap front doors have one clear next task.
- [ ] Generation rollover is considered only if justified.
- [ ] Validation passes or blockers are recorded.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`
