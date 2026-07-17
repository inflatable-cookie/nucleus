# 208 Shared Admission And Evidence Vocabulary

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../045-admission-vocabulary-consolidation.md`
Auto-start next card: no

## Objective

One generic admission/evidence vocabulary in core/orchestration replacing the
per-crate and per-feature copies.

## Steps

- define shared `NoEffects`, `EvidenceRef`, admission-status, and
  diagnostics-count types parameterized by domain in nucleus-core or
  nucleus-orchestration
- migrate the eleven `*EvidenceRef(pub String)` newtypes and the three-plus
  Accepted/RequiresApproval/Blocked/Rejected admission enums onto them
- convert domain crates (command-policy, scm-forge, memory, native-harness)
  first; leave server mass to card 209

## Acceptance

- [x] shared vocabulary exists in `nucleus-core::effects`: `EvidenceRef`,
  `AdmissionStatus`, `EffectState`/`EffectNonTerminalState`/
  `EffectTerminalState` (union across domains)
- [x] eleven `*EvidenceRef(pub String)` newtypes (command-policy, scm-forge,
  native-harness x2, engine, server x5), two identical admission enums
  (scm-forge, native-harness; `UnsupportedCapability` folded into
  `Unsupported`), and the twin effect-state enum families are now `pub use`
  renames of the core types; duplicates deleted
- [x] no behavior change: pure type consolidation, none of the migrated
  types were serialized; memory's two-variant admission enum left alone
  (different shape, not a duplicate)
- [x] `NoEffects` consolidation intentionally deferred to card 209: the ~100
  server structs carry per-domain field names, so the shared shape belongs
  to the gate framework, not a bare struct swap

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop before touching serialized wire formats without a compat note
