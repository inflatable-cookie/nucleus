# 371 Provider Observability Diagnostics DTO

Status: planned
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

- [ ] Observability diagnostics expose useful failure context.
- [ ] Diagnostics grant no provider/task authority.
- [ ] Raw payloads and streams are not serialized.
- [ ] DTO serialization tests cover the new surface.

## Validation

- `cargo test -p nucleus-server provider_observability_diagnostics -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
