# Product Guardrails

Status: draft
Owner: Tom
Updated: 2026-06-15

## Non-Negotiables

- Server-first: clients do not own durable product state.
- Project-first: projects are durable records with repo membership, activity
  state, and task state.
- Harness-native: adapters respect provider-specific mechanics.
- Rust-first: core crates must be independently testable.
- Spec-first: large behavior waits for contracts and acceptance criteria.
- Remote-capable: local-only assumptions need explicit justification.

## Anti-Patterns

- Treating a repo clone as the whole project model.
- Building a Tauri-only app that cannot support remote clients.
- Hiding provider differences behind an over-simple agent abstraction.
- Creating one giant crate for all server, protocol, project, and task logic.
- Shipping UI before project, task, and adapter contracts are stable.

## Next Task

Use these guardrails while drafting the harness adapter and project identity
contracts.
