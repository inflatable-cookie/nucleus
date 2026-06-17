# 050 Codex Handshake Preflight

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../014-codex-live-runtime-supervision.md`

## Purpose

Define and test Codex app-server version, auth, and schema handshake preflight.

## Scope

- Add preflight request/outcome records.
- Validate known app-server method and schema expectations from fixtures.
- Keep live stdio process management behind the supervision boundary.
- Return explicit deferred/blocked outcomes for missing auth or unsupported
  version.

## Acceptance Criteria

- Handshake readiness is explicit before live work is admitted.
- Unsupported schema/version/auth states do not fall through as runtime errors.
- No raw provider payload is stored as durable state.

## Validation

- `cargo test -p nucleus-agent-protocol codex`
- `cargo test -p nucleus-server codex`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if current Codex evidence is too stale to define handshake expectations.

## Outcome

Completed 2026-06-17.

Added compile-only Codex app-server handshake preflight records. The preflight
validates the current version label, auth readiness, generated schema evidence,
required method subset, and experimental user-input posture without opening
stdio or starting provider work.
