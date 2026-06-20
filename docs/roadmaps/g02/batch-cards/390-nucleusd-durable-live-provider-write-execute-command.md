# 390 Nucleusd Durable Live Provider Write Execute Command

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../085-durable-codex-live-provider-write-execution.md`

## Purpose

Add the `nucleusd` command path that can execute one explicitly confirmed
durable Codex live provider-write smoke.

## Scope

- Require both confirmation and effect flags.
- Keep dry-run and confirmation-only modes stopped.
- Execute only through the durable invocation gate.
- Print sanitized outcome, evidence, replay, and receipt ids.

## Acceptance Criteria

- [x] Default command performs no provider write.
- [x] Confirmation-only command performs no provider write.
- [x] Confirmation plus effect flag can invoke the live runner.
- [x] The command reports persisted evidence and replay status when execution
      runs.

## Result

`nucleusd command-runner durable-live-provider-write-smoke` now supports
`--execute-provider-write` and keeps execution blocked unless the durable gate
is ready.

## Validation

- `cargo test -p nucleusd durable_live_provider_write_execute_command -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
