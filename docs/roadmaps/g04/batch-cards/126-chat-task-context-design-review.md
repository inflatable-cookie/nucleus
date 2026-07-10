# 126 Chat Task Context Design Review

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Choose the smallest task interaction that belongs in chat before exposing a
task mutation tool.

## Work

- decide how an active task is represented beside a conversation
- decide when the agent creates tasks directly and when it proposes them
- separate task authoring authority from task dispatch authority
- keep detailed task management in the task panel

## Acceptance

- agent-authored single and batch task creation is selected
- the chat surface keeps one primary conversational flow
- mutation remains server-admitted and operator-visible
