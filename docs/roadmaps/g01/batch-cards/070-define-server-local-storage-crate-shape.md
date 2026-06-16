# 070 Define Server Local Storage Crate Shape

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define the first server-local storage crate shape.

## Scope

- Decide whether storage lives in a new crate or an existing crate.
- Add the minimal crate/module scaffold if needed.
- Define the crate responsibility statement.
- Add module placeholders for errors, backend selection, repository traits,
  in-memory fixtures, and SQLite implementation.
- Ensure memory and planning domains have a place in the storage crate shape,
  even if their behavior lands after project/task/workspace persistence.
- Ensure deep research domains have a place in the storage crate shape, even
  if retrieval, synthesis, and review behavior lands later.
- Update workspace metadata and inventory.

## Out Of Scope

- Real persistence behavior.
- SQLite schema implementation.
- Repository trait implementation.
- Serialization dependencies beyond what the scaffold needs.
- Control API.
- Tauri UI.

## Evidence Questions

- Should the storage crate depend on domain crates or should domain crates
  depend on shared storage vocabulary?
- Which storage abstractions belong in `nucleus-core` versus a server-local
  storage crate?
- Which modules are needed to keep Rust code out of oversized `lib.rs` files?
- Should shared memory and planning records live in their own crates before
  the storage crate references them?
- Should deep research share the planning crate, or should it become a
  dedicated `nucleus-research` crate before storage references it?

## Stop Conditions

- The card implements database behavior.
- The card introduces API, Tauri, or command execution behavior.
- Storage abstractions make projection files the active server database.

## Promotion Targets

- `Cargo.toml`
- `crates/nucleus-local-store`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/006-server-local-state-implementation-runway.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
```

## Decisions

- Storage lives in a new `nucleus-local-store` crate.
- `nucleus-local-store` depends on `nucleus-core` for shared persistence
  vocabulary.
- Domain crates do not depend on storage.
- Shared memory, structured planning, and deep research remain planned domain
  crates for now; the local store crate only leaves room for their persisted
  records.
- `nucleus-core` now names the first storage domains and record kinds.

## Closeout

The crate boundary exists with modular placeholders for backend selection,
domain coverage, repository boundaries, error vocabulary, in-memory fixtures,
and SQLite.

No persistence behavior, repository traits, SQLite schema, transaction model,
serialization dependency, control API, or Tauri behavior was introduced.
