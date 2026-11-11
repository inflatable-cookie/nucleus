# Papercuts

Small, recurring friction worth fixing later. One entry each: date, what
happened, impact, a plausible fix. Remove an entry when it is fixed.

- 2026-09-26 — Project-K has no single command that validates a fresh disposable
  checkout: `effigy qa` assumes `bun install` already ran.
  Impact: the manifest has no qualifying `validation` command to name. Plausible
  fix: a `validate` selector. Surface: `tasks/effigy.tasks.toml`.

- 2026-09-17 and 2026-09-20: A service-side fix does nothing until the build is
  rolled. Surface: queue service deployment.

## Open

<!-- Keep entries short. -->

- The Rhai host exposes no conditional rename or removal, and `renameat2` is
  Linux-only, so cross-process protocols must be built from exclusive create
  alone.
  - Nested detail belongs to the entry.
- **2026-09-10** · `contract_bindings.RUST_MODEL` only matches `CORE_MODEL`
  or `*_MODEL_JSON`. Impact: a later suite cannot reuse the extractor.
