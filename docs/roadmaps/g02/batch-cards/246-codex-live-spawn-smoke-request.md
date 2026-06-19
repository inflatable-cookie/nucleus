# 246 Codex Live Spawn Smoke Request

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../056-codex-live-spawn-smoke-gate.md`

## Purpose

Add the request/admission shape for a constrained live Codex spawn smoke test.

## Scope

- Require accepted spawn intent.
- Require timeout, bounded output, cleanup policy, and payload-retention policy.
- Keep the request separate from real task execution.
- Do not start Codex in this card.

## Acceptance Criteria

- Smoke request is impossible to construct without explicit limits.
- Request records link to runtime instance and spawn-intent refs.
- No task or provider turn state can be mutated by the request.

## Result

Implemented `CodexAppServerLiveSpawnSmokeRequest` with a validating
constructor that requires accepted spawn intent, matching runtime identity,
finite timeout, bounded stdout/stderr, and metadata-only payload retention.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the smoke request would bypass spawn-intent admission.
