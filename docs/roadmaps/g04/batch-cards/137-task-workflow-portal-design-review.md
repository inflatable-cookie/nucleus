# 137 Task Workflow Portal Design Review

Status: completed
Owner: Tom
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Shape the second agent-facing portal as one coherent workflow capability before
exposing lifecycle or dispatch behavior.

## Questions

- which first actions make a created task genuinely usable
- when the agent may dispatch autonomously and when operator confirmation is
  required
- how lifecycle, assignment, dispatch, interruption, recovery, and review stay
  distinct behind one portal
- which outcomes need compact chat receipts or Tasks-panel state
- which advanced controls remain behind menus or disclosures

## Acceptance

- one bounded first action set is selected
- the agent-facing schema stays one `task_workflow` portal
- server admission and revision boundaries remain authoritative
- the normal operator path stays visually simple
- implementation cards are not compiled until these choices are explicit

## Findings

- the existing Rust code has useful but separate task delegation, scheduled
  work-item, durable dispatch, runtime, recovery, and review boundaries
- those internal stages must not become agent-facing actions
- the first portal should expose `inspect` and the high-level `run` intent
- `run` must compose through provider dispatch; an inert schedule-only result
  does not make the task usable
- lifecycle changes should normally follow admitted workflow events rather than
  separate agent lifecycle verbs
- `docs/specs/005-task-workflow-portal.md` holds the provisional authority
  options and receipt shape

## Options Reviewed

Choose initial `run` authority:

- conversation mandate: one explicit instruction authorizes a bounded task or
  runway without per-task confirmations
- durable project autonomy: qualifying ready tasks may run under persistent
  project policy
- unscoped ready-task autonomy: not recommended

## Decision

Use conversation mandate authority for the first slice. One explicit operator
instruction may authorize a single task or snapshotted ready runway without
per-task confirmations. Persistent project autonomy remains later work.

## Evidence

- operator decision on 2026-07-10
- `docs/specs/005-task-workflow-portal.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`
- `docs/contracts/024-harness-mediation-tool-projection-contract.md`
