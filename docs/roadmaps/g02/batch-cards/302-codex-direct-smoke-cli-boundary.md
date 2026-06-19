# 302 Codex Direct Smoke CLI Boundary

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../067-codex-direct-connection-smoke-gate.md`

## Purpose

Expose the stopped-by-default Codex `turn/start` real-write smoke boundary from
`nucleusd`.

## Scope

- Add a `command-runner codex-turn-start-real-write-smoke` command.
- Add `--confirm-real-write` as an explicit eligibility flag.
- Print boundary status, blockers, receipt identity, evidence count, raw
  material policy, task-mutation policy, and provider-write execution state.
- Keep the command as dry-run evidence only.
- Split command helpers into focused modules.

## Acceptance Criteria

- [x] Default command output is blocked.
- [x] Confirmed command output is eligible.
- [x] Both modes report `provider_write_executed=false`.
- [x] Parser rejects unsupported smoke flags.
- [x] Command-runner tests exercise blocked and confirmed modes.

## Validation

- `cargo test -p nucleusd codex_smoke -- --nocapture`
- `cargo test -p nucleusd cli_config_parses_codex -- --nocapture`
- `cargo test -p nucleusd command_runner_codex -- --nocapture`

## Stop Conditions

- Stop before any real Codex provider write.
