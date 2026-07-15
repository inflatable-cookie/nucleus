# 194 Transient Project Retention Boundary

Status: planned
Owner: Codex
Updated: 2026-07-15
Milestone: `../040-transient-chat-and-promotion.md`
Auto-start next card: yes

## Objective

Add transient retention, expiry eligibility, promotion, and durable-child
safeguards to the server-owned project lifecycle.

## Acceptance

- expiry policy is explicit, inspectable, and host-owned
- promotion preserves all project-scoped identities
- tasks, goals, accepted memory, and resources prevent silent expiry
- restart does not accidentally promote or delete transient work

## Stop Conditions

- expiry can race an active turn or work item
- promotion copies conversation history into a replacement project
