# 365 Provider Retry Reconciliation Records

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../080-provider-runtime-hardening.md`

## Purpose

Represent retry and reconciliation decisions for failed or uncertain provider
effects.

## Scope

- Link retry attempts to original commands, receipts, outcomes, and repair
  evidence.
- Distinguish safe retry, unsafe retry, already completed, and manual repair.
- Do not retry automatically.

## Acceptance Criteria

- [ ] Retry decisions are explicit records.
- [ ] Unsafe retries are blocked.
- [ ] Completed effects reconcile without re-execution.
- [ ] Manual repair states are visible.

## Validation

- `cargo test -p nucleus-server provider_retry_reconciliation -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
