# 148 Goal Run Provider Dispatch Bridge

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../027-agent-chat-task-workflow-run.md`

## Purpose

Carry an admitted goal run through durable local Codex execution one task at a
time.

## Work

- compose work items into durable executor selection, admission, preflight,
  invocation, and outcome records
- create task-scoped provider session, thread, and turn linkage
- persist running, wait, completion, failure, cancellation, and recovery events
- advance only after the current task reaches an allowed outcome
- stop the goal on goal/task stop condition, blocker, failure, cancellation, or
  recovery requirement
- retain sanitized evidence refs rather than raw provider material

## Acceptance

- admitted goal run reaches a real provider turn
- scheduling is never reported as execution
- serial advancement follows snapshotted goal membership
- provider completion does not accept review, complete tasks, or achieve goals
- authenticated single-task and two-task goal smokes pass

## Outcome

- admitted Goal runs now execute their frozen task snapshot through real local
  Codex app-server turns, one task at a time
- durable selection, admission, preflight, invocation, source transition, and
  runtime receipt refs preserve the provider chain without raw provider output
- continuation rechecks mandate, Goal, task revision, readiness, and dependency
  state before every task
- completion stops at reviewable evidence; failure, cancellation, interactive
  wait, revocation, and recovery requirements stop serial advancement
- authenticated one-task workspace-write and two-task serial provider smokes
  pass
