# 040 Transient Chat And Promotion

Status: planned
Owner: Tom
Updated: 2026-07-15

## Purpose

Support immediate disposable chat through transient projects and promote useful
work in place without moving conversation or task identity.

## Governing Refs

- `../../specs/012-flexible-project-lifecycle-and-resources.md`
- `../../architecture/project-resource-lifecycle.md`
- `../../contracts/003-project-identity-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`

## Execution Plan

- [ ] Add transient retention, expiry eligibility, promotion, and durable-child
  safeguards to the host boundary.
- [ ] Make New Chat create and focus a resource-free transient project without
  prompting.
- [ ] Add unobtrusive keep/name/attach promotion paths and keep transient work
  out of the normal named-project rail.
- [ ] Validate restart, expiry, promotion, task creation, and resource
  attachment behavior.

## Batch Cards

Planned:

- `batch-cards/194-transient-project-retention-boundary.md`
- `batch-cards/195-new-chat-and-in-place-promotion.md`
- `batch-cards/196-transient-chat-validation.md`
