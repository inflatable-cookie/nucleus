# 043 Notification Presentation And Actions

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../014-notification-ledger-and-attention.md`
Depends on: card 042
Auto-start next card: yes

## Objective

Compose transient toasts and one compact toolbar popover with freshly admitted
semantic actions.

## Acceptance

- [x] toast expiry is independent from seen and dismissed ledger state
- [x] the popover exposes authoritative unseen count and retained records
- [x] actions route through the command catalogue and rerun authorization
- [x] shell attention stays visually restrained

## Validation

- [x] focused Svelte, accessibility, action, and multi-window observation fixtures pass

## Stop Conditions

- do not add permanent notification chrome or direct effect callbacks
