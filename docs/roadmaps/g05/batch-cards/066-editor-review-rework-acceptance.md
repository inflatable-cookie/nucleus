# 066 Editor Review Rework Acceptance

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../021-editor-diff-review-rework-cohesion.md`
Depends on: card 065
Auto-start next card: no

## Objective

Close the selected Task's Editor, Diff review, and Agent Chat rework loop across
deterministic and native desktop paths.

## Acceptance

- [x] single-resource and multi-resource Editor navigation are exact
- [x] accepted and Needs changes outcomes render honestly
- [x] existing draft, closed Agent Chat, project switch, and restart paths hold
- [x] stale or unavailable review evidence does not expose a false action
- [x] no automatic provider execution or task completion occurs

## Validation

- [x] focused Rust, desktop, Svelte, docs, and diff checks pass
- [x] isolated native workflow evidence is recorded

## Stop Conditions

- authenticated provider work requires a separate operator gate

## Evidence

Matching snapshot manifests carry one exact resource id into Diff and Editor.
Disagreement fails closed; legacy or unavailable lineage leaves Open in Editor
disabled. The isolated native app rendered the durable Needs changes note,
switched from Diff to Agent Chat, retained the selected Task, preserved an
existing composer draft, and appended the bounded rework prompt without
submitting it. Authoritative active-panel keys keep Longhorn tab bodies in sync
without remounting on resize ticks. Forty-three Bun tests, 18 mounted tests, 10
panel guards, focused task-diff Rust tests, Svelte checking, build, Rust check,
docs QA, formatting, and diff hygiene pass. The sole Svelte warning remains the
pre-existing ProjectRail pointerdown warning.
