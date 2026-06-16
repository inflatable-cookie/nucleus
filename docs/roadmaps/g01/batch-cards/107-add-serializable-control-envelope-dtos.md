# 107 Add Serializable Control Envelope DTOs

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add serializable DTOs for the first control request and response envelope.

## Scope

- Add DTO types for request and response envelopes.
- Add explicit conversions to and from server control API values where safe.
- Add tests for version, id, status, body, and error-shape handling.
- Keep DTOs at the transport boundary.

## Out Of Scope

- Tauri command macros.
- Desktop scaffolding.
- Live subscriptions.
- Remote transport.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/011-desktop-serialization-and-shell-bootstrap.md`

## Acceptance Criteria

- DTOs are serializable and test-covered.
- Conversion does not let transport DTOs become durable state authority.
- Unsupported payloads fail with explicit codec errors.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```

## Decisions

- DTOs live in `control_envelope_dto.rs`.
- DTOs use serde derives and JSON-compatible shapes.
- Request DTOs support the first state query and runtime metadata query shapes.
- Response DTOs support response status, state record envelopes, command
  receipt summaries, empty/unsupported query responses, and explicit error
  shapes.
- Unsupported payloads return `ControlApiCodecError`.
- DTOs remain transport-boundary values and do not replace server authority
  types.

## Closeout

Added serializable control request and response envelope DTOs with round-trip
tests for version, ids, status, body, state records, and error shape.

No Tauri command macros, desktop scaffolding, live subscriptions, or remote
transport behavior was introduced.
