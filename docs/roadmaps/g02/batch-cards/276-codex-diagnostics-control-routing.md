# 276 Codex Diagnostics Control Routing

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../062-provider-runtime-materialisation-gate.md`

## Purpose

Expose Codex provider diagnostics through the server control API/query surface.

## Scope

- Add diagnostics query/result variants for Codex runtime diagnostics.
- Include recovery diagnostics and the existing Codex turn-start, callback,
  interruption, live-spawn, subscription, and ingestion read models where the
  current control boundary can represent them safely.
- Keep all diagnostics read-only.
- Do not add desktop panels or provider commands.

## Acceptance Criteria

- Control API can represent Codex diagnostics without granting command
  authority.
- Request handling can return empty/sanitized Codex diagnostics for the new
  query path.
- Control DTO serialization can round-trip the new diagnostics query domain if
  that boundary currently supports diagnostics domain strings.
- Raw provider payloads and credentials are not exposed.

## Validation

- [x] targeted server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if routing Codex diagnostics requires a broader transport/DTO redesign.

## Result

Codex provider diagnostics now route through the server diagnostics query
surface as a read-only `codex_provider` domain. The result bundles existing
Codex ingestion, live-spawn, turn-start, subscription, callback, interruption,
and recovery diagnostics without exposing command authority.

Control DTOs round-trip the new domain, and request handler tests assert that
clients cannot control providers or mutate task state through the diagnostics
path.
