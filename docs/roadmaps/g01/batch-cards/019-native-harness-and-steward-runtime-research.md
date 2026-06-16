# 019 Native Harness And Steward Runtime Research

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Research Nucleus native harness and steward runtime semantics.

## Scope

- Compare OpenCode, Pi, and Rust-native agent/runtime structures.
- Define bridged harness versus native harness boundaries.
- Define first steward persona capabilities and limits.
- Evaluate Rust ecosystem candidates for local models and agent orchestration.
- Keep implementation out of scope.

## Out Of Scope

- Native harness implementation.
- Model backend selection.
- Steward agent execution.
- Tool permission implementation.
- UI persona management.

## Evidence Questions

- Which parts of OpenCode and Pi are useful runtime references?
- Should Pi be bridged, embedded, or only referenced?
- Should the native runtime be pure Rust or sidecar-backed?
- Which Rust libraries are useful without overconstraining Nucleus?
- Which steward actions can be automatic under policy?
- How should native harness sessions and events map to shared protocol ideas?

## Stop Conditions

- Native harnesses are modeled as external provider adapters.
- Steward personas can mutate project state without explicit policy.
- Local model selection is hard-coded before backend research.
- Deterministic tools are skipped in favor of model calls for simple operations.

## Promotion Targets

- `docs/research/source-hubs/native-harness-runtime.md`
- `docs/specs/003-nucleus-native-harness-and-steward-runtime.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/architecture/system-architecture.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
