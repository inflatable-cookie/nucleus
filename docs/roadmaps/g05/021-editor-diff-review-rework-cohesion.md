# 021 Editor Diff Review Rework Cohesion

Status: completed
Owner: Tom
Created: 2026-08-03

## Purpose

Turn the existing Editor, task-attributed Diff, review decision, and
review-guided rework features into one short operator workflow built on the
shared project context.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/021-checkpoint-diff-contract.md`
- `../../contracts/023-task-backed-agent-workflow-contract.md`
- `020-shared-work-context.md`

## Generation Runway Goal

Restore one predictable project working context while keeping review compact
and Agent Chat as the normal execution-control surface.

## Goals

- [x] preserve the exact task-review resource when opening a changed file
- [x] keep one selected Task across Diff, Editor navigation, and Agent Chat
- [x] make the durable Needs changes outcome directly actionable
- [x] require an explicit operator send before rework can start
- [x] close with deterministic and native workflow evidence

## Execution Plan

### Batch 21.1 — Authority And Resource Lineage

- [x] execute cards 063 and 064
- [x] settle the product boundary before runtime changes
- [x] carry exact snapshot resource identity through the task-diff read model
  and Editor navigation

### Batch 21.2 — Review-To-Rework Handoff

- [x] execute card 065
- [x] focus or create Agent Chat from a durable Needs changes result
- [x] prepare a bounded prompt without replacing composer text or submitting a
  turn

### Batch 21.3 — Acceptance

- [x] execute card 066
- [x] prove single-resource, multi-resource, existing-draft, panel-closed,
  stale-review, and restart-safe behavior
- [x] stop at the next inward-consolidation checkpoint

## Acceptance Criteria

- [x] Open in Editor resolves the reviewed file against its exact resource
- [x] Needs changes stays visible with its durable note in Diff
- [x] Address changes focuses Agent Chat with the same selected Task
- [x] prepared rework text never starts provider or task execution by itself
- [x] accepted, missing, expired, or stale review state cannot expose false
  rework authority
- [x] the normal path gains no permanent workflow bar or duplicate task model

## Batch Cards

- `batch-cards/063-review-workflow-contract-and-resource-lineage.md`
- `batch-cards/064-exact-diff-to-editor-navigation.md`
- `batch-cards/065-review-to-agent-chat-rework-handoff.md`
- `batch-cards/066-editor-review-rework-acceptance.md`
