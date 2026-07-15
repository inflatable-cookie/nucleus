# 187 Project Lifecycle Command Boundary

Status: ready
Owner: Codex
Updated: 2026-07-15
Milestone: `../038-project-control-workflow.md`
Auto-start next card: yes

## Objective

Add server-owned create, rename, park, archive, restore, and delete commands
with explicit lifecycle admission and durable receipts.

## Acceptance

- commands enforce authority, expected revision, and idempotency
- deletion distinguishes safe empty projects from retained work
- lifecycle history survives restart
- create accepts no filesystem or Git fields

## Stop Conditions

- deletion can silently remove tasks, conversations, memory, or resources
- basic project creation requires topology choices
