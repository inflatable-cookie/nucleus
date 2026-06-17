# 051 Codex Live Event Ingestion

Status: completed
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

- [x] Live Codex event intake can be represented without message identity
  collisions.
- [x] Unsupported provider events are captured as explicit unsupported
  observations.
- [x] Raw provider payload handling remains behind evidence policy.

## Outcome

- Added live Codex app-server ingestion records around decoded event frames.
- Reused the static Codex fixture mapper for canonical runtime event and
  runtime receipt projection.
- Captured unsupported provider observations without retaining raw payloads.
- Preserved Nucleus-owned ids separately from provider turn/item/request refs.

## Validation

- [x] `cargo test -p nucleus-agent-protocol codex`
- [x] `cargo test -p nucleus-server codex`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if provider event identity cannot be mapped without fresh research.
