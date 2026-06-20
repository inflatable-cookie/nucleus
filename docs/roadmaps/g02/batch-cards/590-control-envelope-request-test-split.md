# 590 Control Envelope Request Test Split

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Split the control-envelope request tests that remain an error-sized doctor
finding.

## Scope

- Split request DTO tests by query, command, and diagnostics vocabulary.
- Keep request serialization behavior unchanged.
- Avoid changing request DTO shapes.

## Acceptance Criteria

- [ ] `control_envelope_dto/tests/request.rs` is split into focused files.
- [ ] Existing request DTO assertions are preserved.
- [ ] No request schema changes are introduced.

## Validation

- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
