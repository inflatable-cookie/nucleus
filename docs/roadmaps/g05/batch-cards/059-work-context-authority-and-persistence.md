# 059 Work Context Authority And Persistence

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../020-shared-work-context.md`
Depends on: card 058
Auto-start next card: yes

## Objective

Retain project working focus and Agent Chat panel conversation attachments in
the existing local presentation authority.

## Acceptance

- [x] project context carries optional Goal, Task, and active conversation ids
- [x] Agent Chat presentation carries one optional conversation attachment
- [x] snapshot, mutation, validation, and migration preserve both shapes
- [x] context remains local client state and cannot mutate server product state

## Validation

- [x] focused Rust domain, DTO, migration, and restart fixtures pass

## Stop Conditions

- stop if the design creates a second Goal, Task, conversation, or layout model
- stop if restored ids bypass current-project resolution

## Evidence

The existing panel-presentation domain now stores project-local working context
and Agent Chat conversation attachment. Additive defaults preserve old state.
Focused workspace fixtures pass legacy decode, validation, project isolation,
distinct chat attachment, and restart cases.
