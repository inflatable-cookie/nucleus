# 124 Reassess Read-Only Task List Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Decide whether the desktop can build a read-only task list.

## Scope

- Check display-ready task data.
- Check local task seed/create path.
- Check project-selected task filtering constraints.
- Decide the next UI card.

## Out Of Scope

- Implementing task list.
- Task mutation.
- Agent assignment.

## Promotion Targets

- `docs/roadmaps/g01/015-task-records-and-read-only-list-readiness.md`
- `docs/roadmaps/g01/batch-cards/README.md`

## Acceptance Criteria

- Read-only task list readiness is explicit.
- If ready, next card is scoped to display/list/select only.
- If not ready, blocker is routed to the missing server boundary.

## Result

Read-only task list readiness is now ready.

Evidence:

- task records have a Rust-owned storage codec
- task queries can return typed `task_records` DTOs
- local desktop startup seeds one valid bootstrap task
- task DTOs include `project_id`, so first UI filtering can be view-only
  filtering against shell-selected project id

Constraints for the next UI card:

- list only
- read-only
- selected-project filtering is local view glue
- no task creation, editing, assignment, execution, or persisted selection
- no TypeScript-owned task authority
