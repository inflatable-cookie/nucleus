# 121 Compile Task Record Display And Seed Runway

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Turn the task list blocker into a bounded implementation runway.

## Scope

- Check task contract coverage.
- Choose first task display-data path.
- Choose first task record write path.
- Produce the next implementation cards.

## Result

Task contract coverage is enough for the first display path. The contract
already defines one task per projection file, durable task ids, project ids,
title, description, acceptance criteria, importance, action type, activity,
assignment intent, agent-readiness summary, refs, and low-volume history
summaries.

First display-data path:

- add a Rust-owned task storage codec in `nucleus-tasks`
- expose display-ready task records from `nucleus-server`
- mirror the project record pattern with a typed `task_records` control DTO
- keep TypeScript limited to query construction, list rendering, and local
  selection

First write path:

- add a server-owned local task seed attached to the `Nucleus Local` project
- write through the server state service
- keep seed behavior distinct from general task creation UI

The next implementation card should add the task codec and server display
projection together if the code stays small. If the patch grows, split after
the codec lands.

## Out Of Scope

- Implementing task codec.
- Implementing task seed.
- Implementing task list UI.

## Promotion Targets

- `docs/roadmaps/g01/015-task-records-and-read-only-list-readiness.md`
- `docs/roadmaps/g01/batch-cards/README.md`
- `apps/desktop/README.md`

## Acceptance Criteria

- First task display-data path is chosen.
- First task record write path is chosen.
- Next implementation card is narrow and executable.
- TypeScript task authority remains out of scope.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
