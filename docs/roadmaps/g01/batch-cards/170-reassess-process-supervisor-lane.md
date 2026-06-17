# 170 Reassess Process Supervisor Lane

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Reassess whether process-supervisor module/event work can resume after host
authority-map vocabulary exists.

## Scope

- Check execution authority representation.
- Decide whether card 160 can resume.
- Update the next task pointer.

## Out Of Scope

- Process spawning.
- Host registry persistence.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- Process-supervisor lane is resumed, narrowed, or left paused explicitly.
- Next task is host-authority aware.

## Closeout

- Process-supervisor lane is resumed.
- Next process-supervisor work must include execution authority checks.
