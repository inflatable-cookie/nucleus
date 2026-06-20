# 380 Durable Codex Live Smoke Dispatch Runner

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../083-durable-codex-live-smoke-execution.md`

## Purpose

Route the durable live smoke through server-owned dispatch and invocation
records.

## Scope

- Build from the boundary record, not from ad hoc CLI flags.
- Reuse durable executor command, dispatch admission, invocation preflight,
  invocation request, and executor handoff records.
- Keep provider I/O behind the existing explicit effect gate.
- Return sanitized dry-run output when execution is not eligible.

## Acceptance Criteria

- [x] Dry-run produces dispatch/invocation evidence without provider I/O.
- [x] Eligible real-write mode reaches the live executor handoff boundary.
- [x] Provider execution remains impossible without confirmation and effect
      flag.
- [x] The runner does not mutate task, review, callback, resume, interruption,
      recovery, or SCM state.

## Result

Added `provider_durable_codex_live_smoke_runner`, assembling durable command,
selection, dispatch admission, invocation preflight, invocation request,
handoff, and boundary records without executor invocation or provider writes.

## Validation

- `cargo test -p nucleus-server durable_codex_live_smoke_dispatch -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
