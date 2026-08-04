# 063 Review Workflow Contract And Resource Lineage

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../021-editor-diff-review-rework-cohesion.md`
Depends on: card 062
Auto-start next card: yes

## Objective

Settle the compact Editor, Diff review, and Agent Chat rework boundary and
identify the exact source-resource lineage needed by navigation.

## Acceptance

- [x] contracts distinguish prepared rework text from execution authority
- [x] Diff-to-Editor navigation requires resource id, display path, and file ref
- [x] existing review, Task, file, and conversation authorities remain intact
- [x] no specialist workflow shell or duplicate read model is introduced

## Validation

- [x] Northstar docs QA passes

## Stop Conditions

- stop if snapshot resource identity cannot be resolved without guessing
- stop if the handoff would auto-submit or bypass task workflow admission

## Evidence

Contracts 006, 021, and 023 now preserve exact review-resource lineage and
classify prepared composer text as transient, non-executing UI state. Docs QA
passes.
