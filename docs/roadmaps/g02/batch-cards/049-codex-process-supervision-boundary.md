# 049 Codex Process Supervision Boundary

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../014-codex-live-runtime-supervision.md`

## Purpose

Prepare the first owned Codex app-server process supervision boundary without
starting real provider work yet.

## Scope

- Add compile-only records for Codex app-server process intent, readiness, and
  supervision limits.
- Reuse existing Codex schema/fixture evidence and host authority records.
- Require execution authority, auth posture, protocol profile, and local
  transport posture before live start is considered ready.
- Keep actual spawning, stdio wiring, auth probing, and live event ingestion
  out of scope.

## Acceptance Criteria

- Nucleus can represent a Codex app-server supervision request without
  launching it.
- Readiness blockers distinguish missing binary, missing auth, missing
  execution authority, unsupported protocol, and transport not ready.
- The record shape is specific to Codex but does not leak raw provider payloads
  into durable state.

## Validation

- `cargo test -p nucleus-agent-protocol codex`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if live spawning, provider auth, or stdio handshake behavior is needed
  to define the readiness shape.

## Outcome

Completed 2026-06-17.

Added compile-only Codex app-server supervision readiness records in
`nucleus-server`. The boundary composes binary availability, client auth,
execution authority, v1 protocol profile, local transport readiness,
process-control readiness, live-spawn allowance, and sanitized payload policy
without spawning Codex or opening stdio.
