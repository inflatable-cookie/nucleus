# 022 Portable Work Projection Persistence

Status: completed
Owner: Tom
Created: 2026-07-31
Milestone: `../007-structured-provider-work.md`
Depends on: card 021
Auto-start next card: yes

## Objective

Carry actor, task-list, and subagent snapshot structure through storage,
history, and live desktop DTOs without semantic loss.

## Acceptance

- [x] actor attribution remains main, child, or unknown
- [x] task-list content, status, priority, and order survive replay
- [x] replacement, omission, and empty-clear semantics have fixtures
- [x] subagent snapshot parent and status uncertainty survive replay

## Evidence

- stored activity and desktop DTOs retain Swallowtail actor, task-list, and
  subagent snapshot fields without provider-native parsing.
- focused Rust projection and desktop replacement/omission/clear fixtures pass.
