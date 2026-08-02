# 044 Notification Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../014-notification-ledger-and-attention.md`
Depends on: card 043
Auto-start next card: yes

## Objective

Close retained-attention behavior across replacement, retention, remount,
multiple windows, and native interaction.

## Acceptance

- [x] unseen count never derives from retained count
- [x] replacement and dismissal survive remount and restart
- [x] multiple observers do not duplicate records or actions
- [x] native visual and keyboard behavior remain quiet and usable

## Validation

- [x] focused Rust, desktop, Svelte, accessibility, and native checks pass

## Stop Conditions

- stop if notification presentation becomes a second product history
