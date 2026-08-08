# 084 Plan Decision Contract Amendments

Status: completed
Owner: Tom
Created: 2026-08-07
Milestone: `../025-plan-decision-agent-chat.md`
Depends on: card 083
Auto-start next card: no

## Objective

Record the locked plan-decision decisions in the governing contracts before
server or desktop implementation begins.

## Acceptance

- [x] contract 026 defines plan-decision promotion with provenance
- [x] contract 019 adds a Plan Decision Rule sibling to the Provider Question Rule
- [x] contract 030 binds the plan-decision route to existing Agent Chat session rules
- [x] no mid-session mode switch is claimed or faked

## Validation

- [x] docs QA passes

## Stop Conditions

- do not implement server, desktop, or harness behavior in this card
- do not widen the amendments beyond the locked operator decisions

## Evidence

- `docs/contracts/026-open-ended-planning-conversation-contract.md` gains the
  Plan Decision Promotion Rule: accept is explicit, durable, reviewable; the
  record carries outcome, source turn id, plan activity correlation, and the
  reviewed snapshot; dismissed and revised plans are durable truth; acceptance
  alone does not promote.
- `docs/contracts/019-conversation-timeline-contract.md` gains the Plan
  Decision Rule: first-class timeline exchange, exactly one decision per
  proposed plan, pending plans separately queryable for composer plan review,
  settled record rendered as `decided-plan`, never a synthesized user message.
- `docs/contracts/030-swallowtail-agent-runtime-integration-contract.md`
  binds accepting a plan to a Normal-mode prepared session per contract 010's
  Effective Session Mode rule and the existing route-mismatch fresh-session
  behavior.
