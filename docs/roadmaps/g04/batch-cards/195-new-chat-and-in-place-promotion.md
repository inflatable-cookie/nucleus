# 195 New Chat And In-Place Promotion

Status: completed
Owner: Claude
Updated: 2026-07-18
Milestone: `../040-transient-chat-and-promotion.md`
Auto-start next card: yes

## Objective

Make New chat open an immediate resource-free transient project and add quiet
paths to keep, name, or attach it.

## Acceptance

- [x] New chat asks no setup questions: one rail button creates and
  focuses a transient resource-free project ("New Chat") immediately
- [x] transient chats stay out of the named-project rail: they render in
  their own quiet Chats group (guarded by a panel test)
- [x] keeping, naming, task creation, or resource attachment promotes in
  place: Keep/Name promote via the lifecycle command; task and goal
  creation auto-promote through the host's durable-child admission rule
  (receipted as `promote` by `system:durable-child-admission`); resource
  attach flips retention durable inside its own mutation
- [x] filesystem-free chat uses an honest provider working-context policy:
  resource-free projects run chat against the host home directory
  read-only, mirroring the terminal's zero-resource fallback; file-backed
  actions still require an attached resource

## Stop Conditions

- disposable chat requires a fake repository or hidden client folder
- promotion changes conversation, goal, task, or memory ids
