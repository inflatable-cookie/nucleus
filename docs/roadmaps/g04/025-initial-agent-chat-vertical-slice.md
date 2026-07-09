# 025 Initial Agent Chat Vertical Slice

Status: active
Owner: Tom
Updated: 2026-07-09

## Purpose

Put the first real workflow inside the existing Agent Chat panel without
changing the approved workspace shell.

This lane proves one local project-scoped Codex conversation before task
linkage is added.

## Boundary

This lane may:

- start one server-owned local Codex app-server session per Agent Chat panel
- keep follow-up turns on the same provider thread while the desktop is open
- resolve the working directory from server-owned project state
- render user and assistant messages in the existing Agent Chat panel
- use read-only workspace access with no approval escalation

This lane must not:

- change workspace surface, region, docking, or panel placement behavior
- create or mutate tasks
- present the local in-memory transcript as a durable canonical timeline
- claim restart recovery before session and message records are persisted
- add tool, approval, or structured user-input UI before those flows are
  admitted through product control surfaces

## Batch Cards

Ready cards:

- `batch-cards/124-agent-chat-product-design-review.md`

Completed cards:

- `batch-cards/123-local-agent-chat-vertical-slice.md`
