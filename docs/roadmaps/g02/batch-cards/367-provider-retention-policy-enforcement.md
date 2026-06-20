# 367 Provider Retention Policy Enforcement

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../080-provider-runtime-hardening.md`

## Purpose

Enforce provider payload, stream, and artifact retention policy at record
boundaries.

## Scope

- Reject raw payloads, raw streams, secrets, credentials, and unbounded local
  paths by default.
- Allow only evidence refs and policy-approved artifact refs.
- Add tests across provider runtime record families.

## Acceptance Criteria

- [ ] Forbidden retention is rejected consistently.
- [ ] Approved artifact refs remain reference-only.
- [ ] Tests cover provider payload and stream boundaries.
- [ ] Diagnostics expose policy blockers, not raw material.

## Validation

- `cargo test -p nucleus-server provider_retention_policy -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
