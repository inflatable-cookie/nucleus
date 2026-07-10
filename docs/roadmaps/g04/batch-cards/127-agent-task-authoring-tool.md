# 127 Agent Task Authoring Tool

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Let the chat agent create one durable task or a longer runway without per-task
confirmation.

## Scope

- expose one Codex dynamic tool for task batches
- accept rich task intent and readiness fields
- add conversation, provider-turn, and dependency provenance
- route every write through the existing server task command boundary
- keep creation separate from delegation and dispatch

## Acceptance

- the provider cannot write task storage directly
- the full batch is validated before the first command runs
- clear tasks may be marked ready; incomplete tasks remain proposed
- task creation schedules no work
