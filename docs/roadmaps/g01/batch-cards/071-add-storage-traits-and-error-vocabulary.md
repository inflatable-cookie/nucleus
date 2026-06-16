# 071 Add Storage Traits And Error Vocabulary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add storage trait and error vocabulary for server-local durable records.

## Scope

- Define storage errors, record revision checks, transaction posture, and
  repository trait vocabulary.
- Keep traits small and domain-oriented.
- Add compile tests for trait shape.

## Out Of Scope

- SQLite implementation.
- Serialization format commitment beyond trait payload boundaries.
- Control API.
- Runtime scheduling.

## Validation

```sh
cargo check --workspace
cargo test --workspace
```

## Decisions

- Repository traits are synchronous and value-shaped for now.
- Storage payloads are opaque bytes with optional media type, so this card
  does not choose TOML, JSON, bincode, normalized SQL rows, or another
  serialization format.
- Revision expectations are explicit write inputs.
- Transaction posture is symbolic until a backend implementation exists.
- Errors are typed but backend-neutral.

## Closeout

`nucleus-local-store` now has storage errors, revision-check vocabulary,
transaction posture vocabulary, generic local-store record types, and a small
repository trait.

No SQLite behavior, schema, serialization dependency, control API, runtime
scheduling, or repository implementation was introduced.
