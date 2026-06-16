# 107 Add Serializable Control Envelope DTOs

Status: planned
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
