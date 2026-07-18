# 194 Transient Project Retention Boundary

Status: completed
Owner: Claude
Updated: 2026-07-18
Milestone: `../040-transient-chat-and-promotion.md`
Auto-start next card: yes

## Objective

Add transient retention, expiry eligibility, promotion, and durable-child
safeguards to the server-owned project lifecycle.

## Acceptance

- [x] expiry is explicit and host-owned: an `expire_transient` lifecycle
  command with admission (no automatic sweep); refusal reasons make
  eligibility inspectable
- [x] promotion preserves all project-scoped identities: `promote` flips
  retention in place on the same project record (engine test pins the id)
- [x] tasks, goals, accepted memory, and resources block expiry with an
  explicit retention-decision refusal (kind-aware domain scan; goals
  filtered from planning records; conversations do not block — transient
  chat expires with its project)
- [x] restart cannot promote or delete transient work: both are explicit
  idempotency-fingerprinted lifecycle commands, and creation defaults the
  transient name to "New Chat" with retention persisted in the project
  record

## Stop Conditions

- expiry can race an active turn or work item
- promotion copies conversation history into a replacement project
