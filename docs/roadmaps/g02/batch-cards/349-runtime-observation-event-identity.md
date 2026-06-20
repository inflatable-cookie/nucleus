# 349 Runtime Observation Event Identity

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../077-codex-runtime-observation-event-store-linkage.md`

## Purpose

Define stable event identity for accepted provider runtime observations.

## Scope

- Derive ids from provider instance, runtime session, frame/decode refs, method,
  sequence, and observation kind.
- Include confidence and repair state.
- Do not collapse unsupported methods into generic success/failure.

## Acceptance Criteria

- [ ] Observation event ids are deterministic.
- [ ] Unsupported observations keep visible identity.
- [ ] Mismatched session identity blocks acceptance.
- [ ] Records are replay-safe.

## Validation

- `cargo test -p nucleus-server runtime_observation_event_identity -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
