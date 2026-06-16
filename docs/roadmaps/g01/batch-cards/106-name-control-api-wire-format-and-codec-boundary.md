# 106 Name Control API Wire Format And Codec Boundary

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Name the control API wire format and codec boundary before adding serializable
DTOs.

## Scope

- Decide the first wire format for desktop IPC envelopes.
- Name protocol versioning rules.
- Name codec responsibility and failure vocabulary.
- Keep server authority types separate from transport DTOs.

## Out Of Scope

- Adding serde derives.
- Implementing codecs.
- Tauri command wiring.
- Desktop scaffolding.

## Promotion Targets

- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/011-desktop-serialization-and-shell-bootstrap.md`

## Acceptance Criteria

- The first wire format is explicit.
- Versioning and compatibility rules are named.
- DTOs are clearly transport boundary types, not durable state authority.
- The next card can implement serializable envelope DTOs without guessing.

## Validation

```sh
cargo test --workspace
cargo fmt --all --check
```
