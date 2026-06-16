# 009 Runtime Event Payload Schema

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Draft the runtime event payload schema that sits behind
`AdapterRuntimeEvent`.

## Scope

- Define canonical payload families for session, turn, message, content delta,
  tool call, command execution, file change, approval, user input, usage,
  warning, error, and provider extension events.
- Preserve raw provider payloads for diagnostics without making UI clients
  depend on provider-specific JSON.
- Define how synthetic ids, provider-native ids, and replayed transcript ids
  attach to event payloads.
- Keep provider-specific gaps explicit.

## Out Of Scope

- Provider adapter implementations.
- Full async stream implementation.
- Storage backend decisions.
- UI rendering rules.

## Evidence Questions

- Which payload fields are common enough to be canonical?
- Which fields must remain provider extension metadata?
- How should approvals differ from structured user input?
- How should command execution differ from tool-call lifecycle?
- How should replayed transcript entries differ from live runtime events?

## Stop Conditions

- Payloads depend on one provider's native schema.
- Raw provider payloads replace canonical fields.
- Synthetic ids are hidden from clients.
- Event payloads force terminal-only adapters to pretend they have structured
  messages.

## Promotion Targets

- `docs/contracts/002-harness-adapter-contract.md`
- `crates/nucleus-agent-protocol/src/events.rs`
- `crates/nucleus-agent-protocol/src/traits.rs`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft management projection file model.
