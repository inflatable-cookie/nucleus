# 053 Secondary Window Native Acceptance

Status: paused behind card 052
Owner: Tom
Created: 2026-08-01
Milestone: `../017-secondary-window-panel-transfer.md`
Depends on: card 052
Auto-start next card: no

## Objective

Prove the selected multi-window workflow natively across transfer, display,
restart, close, and recovery boundaries.

## Acceptance

- [ ] drag, stale target, display change, restart, close, and rollback pass
- [ ] primary-window behavior remains unchanged without a secondary window
- [ ] panel focus and accessibility survive successful transfer
- [ ] exact absence of hosted Surface state is audited

## Validation

- [ ] focused desktop fixtures and separately gated native multi-window proof pass

## Stop Conditions

- stop if the selected workflow requires an uncontracted window role
