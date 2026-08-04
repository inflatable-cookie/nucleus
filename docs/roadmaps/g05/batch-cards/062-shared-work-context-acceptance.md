# 062 Shared Work Context Acceptance

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../020-shared-work-context.md`
Depends on: card 061
Auto-start next card: no

## Objective

Close shared working context across deterministic and native desktop paths.

## Acceptance

- [x] project switching and restart restore Goal, Task, and active thread
- [x] panel close, move, and reopen preserve intended context
- [x] stale and cross-project ids clear safely
- [x] no extra normal-path UI or duplicate durable authority exists

## Validation

- [x] focused Rust, desktop, Svelte, docs, and diff-hygiene checks pass
- [x] native context switching and restart evidence is recorded

## Stop Conditions

- authenticated provider execution is outside this presentation lane

## Evidence

A fresh fixture-backed bundle retained Task focus through project switching,
Tasks closure, full app restart, and Tasks reopening. The composer remained the
visible cross-panel projection. No authenticated provider work ran. See
`../../../logs/2026-08-03-shared-work-context.md`.
