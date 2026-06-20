# 370 Provider Support Bundle Manifest

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../081-provider-observability-diagnostics.md`

## Purpose

Define support bundle manifests for provider runtime evidence.

## Scope

- Enumerate session, receipt, outcome, trace, repair, and artifact refs.
- Include retention policy and redaction posture.
- Keep payload collection out of scope.

## Acceptance Criteria

- [ ] Support bundle manifests list evidence refs.
- [ ] Raw provider material is not included.
- [ ] Missing evidence is represented as a repair need.
- [ ] Manifests are client-safe.

## Validation

- `cargo test -p nucleus-server provider_support_bundle_manifest -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
