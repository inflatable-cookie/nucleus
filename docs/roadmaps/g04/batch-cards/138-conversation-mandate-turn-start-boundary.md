# 138 Conversation Mandate Turn-Start Boundary

Status: superseded
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Make the current operator message canonical before provider tool calls so a
future run mandate can cite real Nucleus authority rather than model assertion.

## Work

- split chat turn persistence into turn-start and turn-completion boundaries
- persist the user message before starting the provider turn
- make retry, provider failure, and incomplete-turn state explicit
- define and persist a conversation mandate record with message, excerpt,
  project, conversation, scope, task revision, idempotency, expiry, and outcome
  refs
- validate that the excerpt exists in the current canonical user message
- reject assistant-message, stale-turn, cross-project, and scope-expansion
  authority

## Acceptance

- provider tools can cite a canonical current user message
- failed provider turns retain honest incomplete state without duplicate user
  messages on retry
- mandate validation is deterministic and effect-free
- no task, work-item, provider, lifecycle, or SCM mutation is introduced
- focused persistence and mandate tests pass

## Superseded By

`143-goal-domain-and-task-membership.md` through
`149-task-workflow-portal-receipts-and-live-validation.md`. Mandate scope must
be goal-based before turn-start authority is implemented.
