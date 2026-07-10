# 129 Live Agent Task Authoring Validation

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Prove that a normal Agent Chat turn can create a useful task runway through the
live Codex callback path.

## Work

- ask the agent to create one well-specified task
- ask the agent to create a small dependent task runway
- confirm compact chat receipts and automatic task-panel refresh
- inspect created fields, readiness, provenance, and absence of dispatch
- fix only defects found in this bounded live flow

## Acceptance

- both single and batch tool calls complete through live Codex
- created tasks appear in the existing task panel
- fields and proposed/ready states match the request
- no work item, provider execution, SCM action, or forge action is created

## Evidence

- authenticated Codex app-server smoke created two ready tasks
- the provider used two calls; Nucleus consolidated them into one turn receipt
- both task records and the durable receipt survived server-state reads
- runtime-effect storage remained empty
- a legacy resumed conversation initially lacked dynamic tools because Codex
  only accepts them at thread start
- capability-version migration now preserves Nucleus history, starts a
  tool-enabled provider thread, and passes the operator's natural create-task
  wording without special prompting
