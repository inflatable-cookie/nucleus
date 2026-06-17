# 051 Codex Live Event Ingestion

Status: ready
Owner: Tom
Updated: 2026-06-17
Milestone: `../014-codex-live-runtime-supervision.md`

## Purpose

Connect a live Codex event stream to the existing canonical event mapping
surface after supervision and handshake readiness exist.

## Scope

- Reuse static Codex fixture mappings.
- Add live event ingestion records and unsupported-event handling.
- Preserve Nucleus-owned ids and provider external refs.
- Keep UI rendering and task delegation out of scope.

## Acceptance Criteria

- Live Codex event intake can be represented without message identity
  collisions.
- Unsupported provider events are captured as explicit unsupported observations.
- Raw provider payload handling remains behind evidence policy.

## Validation

- `cargo test -p nucleus-agent-protocol codex`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if provider event identity cannot be mapped without fresh research.
