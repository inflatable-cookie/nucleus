# 371 Provider Observability Diagnostics DTO

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../081-provider-observability-diagnostics.md`

## Purpose

Expose provider observability through read-only diagnostics DTOs.

## Scope

- Show trace spans, support bundle manifests, repair states, backpressure, and
  retention blockers.
- Route through Codex provider diagnostics.
- Keep diagnostics sanitized.

## Acceptance Criteria

- [x] Observability diagnostics expose useful failure context.
- [x] Diagnostics grant no provider/task authority.
- [x] Raw payloads and streams are not serialized.
- [x] DTO serialization tests cover the new surface.

## Validation

- `cargo test -p nucleus-server provider_observability_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
