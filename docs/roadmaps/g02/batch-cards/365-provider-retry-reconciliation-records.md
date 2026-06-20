# 365 Provider Retry Reconciliation Records

Status: completed
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

- [x] Retry decisions are explicit records.
- [x] Unsafe retries are blocked.
- [x] Completed effects reconcile without re-execution.
- [x] Manual repair states are visible.

## Validation

- `cargo test -p nucleus-server provider_retry_reconciliation -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
