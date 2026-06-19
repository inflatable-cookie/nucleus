# 238 Codex Task Runtime Observation Links

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../054-codex-live-event-acceptance.md`

## Purpose

Link accepted Codex observations to task work items without direct task
mutation.

## Scope

- Add reference-only task-work observation link records.
- Expose work-item evidence refs for accepted events, unsupported observations,
  wait states, and receipts.
- Keep runtime completion separate from review acceptance and task completion.
- Do not implement automatic task state transitions.

## Acceptance Criteria

- Task work items can query relevant accepted observation refs.
- Provider completion cannot complete a task.
- Wait and recovery states stay visible.

## Result

`nucleus-server` now has task runtime observation link records under
`codex_task_runtime/observation_links.rs`.

The records attach Codex observation source refs, event-store event refs,
receipt refs, and not-linked reasons to the owning task work item. They set
`permits_task_state_mutation` to `false`, so provider completion still cannot
complete a task or accept work.

## Validation

- targeted engine/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if linkage would copy raw provider streams into task records.
