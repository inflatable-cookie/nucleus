# 121 Control Envelope Request Query Module Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../036-control-envelope-request-boundary-split.md`

## Purpose

Move control request envelope, request body, query DTO, state-domain DTO, and
query-scope DTO definitions into focused `control_envelope_dto/` modules.

## Acceptance Criteria

- [x] `ControlRequestEnvelopeDto`, `ControlRequestBodyDto`, and
  `ControlQueryDto` keep their public names and behavior.
- [x] State-domain and query-scope DTOs keep their public names and behavior.
- [x] `control_envelope_dto.rs` remains the front door and re-export surface.
- [x] No provider, SCM, UI, remote transport, or task behavior is added.

## Validation

- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
