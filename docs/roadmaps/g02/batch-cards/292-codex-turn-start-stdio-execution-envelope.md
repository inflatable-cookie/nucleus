# 292 Codex Turn Start Stdio Execution Envelope

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Build the sanitized execution envelope for the first Codex `turn/start` stdio
write handoff.

## Scope

- Preserve request, envelope, command, preflight, write-attempt, receipt, and
  provider instance identity.
- Keep payload content behind references.
- Declare idempotency key and execution attempt id.
- Keep execution disabled unless authority records allow handoff.

## Acceptance Criteria

- [x] The envelope has stable identity and causal refs.
- [x] The envelope does not retain raw provider payloads.
- [x] Blocked authority prevents execution handoff.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if existing write-attempt identity is insufficient for idempotency.
