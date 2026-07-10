# 141 Task Run Provider Dispatch Bridge

Status: superseded
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Carry an admitted task run through the existing durable executor machinery to
real local Codex provider execution.

## Work

- compose admitted work items into durable executor selection, admission,
  preflight, invocation, and outcome records
- create task-scoped provider session/thread/turn linkage
- start the first task with the admitted repository, model route, sandbox, and
  task context
- persist running, wait, completion, failure, cancellation, and recovery
  observations through engine-owned transitions
- advance the serial runway only after the current task reaches an allowed
  outcome; stop on blocker, failure, cancellation, or recovery
- retain sanitized refs rather than raw provider or terminal material

## Acceptance

- admitted `run` reaches a real provider turn
- scheduling alone is never reported as started
- task and work-item state follow admitted runtime evidence
- provider completion does not accept review or complete the task
- authenticated single-task and two-task serial smokes pass

## Superseded By

`148-goal-run-provider-dispatch-bridge.md`.
