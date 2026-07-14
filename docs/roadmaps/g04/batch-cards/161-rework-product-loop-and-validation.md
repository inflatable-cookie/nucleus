# 161 Rework Product Loop And Validation

Status: completed
Owner: Codex
Updated: 2026-07-11
Milestone: `../030-review-guided-rework-execution.md`
Auto-start next card: no

## Objective

Validate the chat-led Needs changes to fresh Diff loop and stop for operator
review.

## Scope

- keep the existing `task_workflow` receipt and task refresh path
- confirm Diff selects the new reviewable work-item diff
- validate note visibility, chat continuity, Editor navigation, and authority
- record remaining Goal rework and completion gaps without selecting them

## Acceptance Criteria

- one explicit chat request can address the displayed review note
- the new receipt and Diff point at the new work item
- old review evidence remains inspectable
- no new tool, sidebar, automatic run, task completion, or SCM mutation exists

## Validation

- `effigy test`
- `effigy desktop:build`
- `effigy desktop:check`
- `effigy qa:docs`
- `cargo fmt --all -- --check`
- `git diff --check`

## Next

Stop for operator review.

## Outcome

- Operator smoke confirmed that the agent reads the persisted Needs changes
  note without it being repeated and runs a fresh rework iteration.
- The existing receipt refreshes Tasks and Diff onto the new reviewable work
  item while prior decision/work/evidence refs remain durable.
- Full validation passes: 2,143 tests, 10 skipped; desktop build and Svelte
  check pass with zero diagnostics; docs, formatting, and diff hygiene pass.
- No new tool, sidebar, automatic execution, task completion, or SCM mutation
  was added.
