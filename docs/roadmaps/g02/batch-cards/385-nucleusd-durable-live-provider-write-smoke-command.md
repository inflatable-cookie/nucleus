# 385 Nucleusd Durable Live Provider Write Smoke Command

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../084-durable-codex-live-provider-write-invocation.md`

## Purpose

Expose the durable live provider-write smoke gate through `nucleusd`.

## Scope

- Add a command that defaults to dry-run.
- Require explicit confirmation and effect flag for invocation eligibility.
- Keep actual provider invocation behind the invocation gate.
- Print sanitized ids, statuses, blocker counts, and evidence refs only.

## Acceptance Criteria

- [x] Default command performs no provider write.
- [x] Confirmation-only mode performs no provider write.
- [x] Confirmation plus effect flag reports invocation eligibility.
- [x] Unsupported flags are rejected.

## Result

Added `nucleusd command-runner durable-live-provider-write-smoke` with explicit
write/effect confirmation flags and sanitized gate output.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_smoke -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
