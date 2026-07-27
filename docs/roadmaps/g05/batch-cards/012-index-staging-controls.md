# 012 Index Staging Controls

Status: completed
Owner: Tom
Updated: 2026-07-27
Milestone: `../004-forge-working-copy-controls.md`

## Objective

Add bounded Stage and Unstage actions over fresh observed paths.

## Acceptance

- [x] row actions mutate only exact observed paths
- [x] repository-group actions use the same bounded multi-path request
- [x] authority host, stale status, conflict, and idempotency checks are
  server-owned
- [x] discard, hunk apply, commit, push, and forge authority remain absent
