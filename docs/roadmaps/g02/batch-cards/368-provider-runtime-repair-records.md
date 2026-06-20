# 368 Provider Runtime Repair Records

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../080-provider-runtime-hardening.md`

## Purpose

Represent repair-required provider runtime states.

## Scope

- Record missing frame, decode failure, provider identity mismatch, uncertain
  outcome, stale cursor, and retention-policy repair needs.
- Preserve evidence refs and suggested next repair action.
- Do not perform repair automatically.

## Acceptance Criteria

- [ ] Repair states are explicit and inspectable.
- [ ] Repair records link to causal evidence.
- [ ] Automatic recovery remains blocked.
- [ ] Validation passes or blockers are recorded.

## Validation

- `cargo test -p nucleus-server provider_runtime_repair_records -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
