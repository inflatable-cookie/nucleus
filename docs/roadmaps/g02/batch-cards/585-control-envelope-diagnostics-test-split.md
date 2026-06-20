# 585 Control Envelope Diagnostics Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Split the largest control-envelope diagnostics response tests into focused
domain files.

## Scope

- Keep serialization/deserialization coverage intact.
- Group diagnostics response tests by domain or response family.
- Avoid adding new DTO behavior.

## Acceptance Criteria

- [ ] `control_envelope_dto/tests/response/diagnostics.rs` is split into
  smaller focused files.
- [ ] Existing DTO fixtures remain readable.
- [ ] No response shape changes are introduced.

## Validation

- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
