# 146 Goal Mandate Turn Start Boundary

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Persist the current operator message and a goal-scoped mandate before provider
tools can request execution.

## Work

- split chat persistence into turn-start and turn-completion boundaries
- retain honest incomplete and failed turns without duplicate user messages
- persist mandate id, current user message/excerpt, conversation, project, goal
  id/revision, membership snapshot, task revisions, idempotency, expiry, and
  outcome refs
- validate exact current-message citation and selected-goal references
- reject assistant, stale-turn, cross-project, changed-goal, arbitrary-task-set,
  and scope-expansion authority
- add cancellation and revocation state without provider effects

## Acceptance

- a run tool can cite canonical operator authority
- one mandate snapshots one goal and at most 50 ordered tasks
- later goal membership changes cannot widen the active scope
- mandate validation is deterministic and effect-free
- focused persistence and authority tests pass
