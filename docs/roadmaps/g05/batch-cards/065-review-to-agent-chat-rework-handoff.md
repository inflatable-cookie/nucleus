# 065 Review To Agent Chat Rework Handoff

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../021-editor-diff-review-rework-cohesion.md`
Depends on: card 064
Auto-start next card: yes

## Objective

Make a durable Needs changes outcome actionable through the existing Agent
Chat composer without granting execution authority.

## Acceptance

- [x] Diff exposes one compact action only for current Needs changes
- [x] the action focuses or creates Agent Chat with the selected Task retained
- [x] the composer receives a bounded task-workflow rework prompt
- [x] existing composer text is preserved and duplicate requests are bounded
- [x] no message, provider turn, task run, or patch transfer occurs automatically

## Validation

- [x] focused prompt-admission, component, and workspace fixtures pass

## Stop Conditions

- do not add an agent tool or direct rework command to Diff
- do not include patch bytes or provider-native ids in the prepared prompt

## Evidence

Needs changes now exposes one Address changes action. The workspace activates
or creates Agent Chat and sends it a transient draft request. The composer
preserves existing text, deduplicates the exact prompt, and never submits.
Forty-two Bun tests, 18 mounted tests, type checking, and panel guards pass.
