# 013 Local Commit Control

Status: completed
Owner: Tom
Updated: 2026-07-27
Milestone: `../004-forge-working-copy-controls.md`
Auto-start next card: no

## Objective

Add the first compact operator-authored commit over an exact staged index.

## Acceptance

- [x] composer appears only when staged paths exist
- [x] the server rejects stale, empty, conflicted, or wrong-host requests
- [x] hooks, signing, prompts, editor fallback, and implicit staging are
  disabled
- [x] raw message text and command output are not persisted
- [x] success returns the resulting commit object id and fresh status
- [x] replay is a no-op and idempotency-key rebinding is rejected

## Stop Conditions

- commit requires task or Goal mutation
- push, publication, forge, credential, hook, or signing authority is needed
- the UI grows branch, author, amend, or advanced Git controls
