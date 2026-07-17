# Shared Admission Vocabulary

Date: 2026-07-17
Lane: g04 admission vocabulary consolidation

## Outcome

- `nucleus-core::effects` now holds the shared vocabulary: `EvidenceRef`,
  `AdmissionStatus` (Accepted / RequiresApproval / Blocked / Rejected /
  Unsupported), and the `EffectState` family (union of the command and
  adapter variant sets)
- eleven per-crate `*EvidenceRef(pub String)` newtypes, the twin
  effect-state enum trios in command-policy and scm-forge, and the identical
  admission enums in scm-forge and native-harness are now `pub use` renames
  of the core types; scm-forge's `UnsupportedCapability` folded into the
  shared `Unsupported`
- command-policy, scm-forge, and native-harness gained their first
  `nucleus-core` dependency — the vocabulary now flows top-down instead of
  being re-declared per crate
- memory's two-variant acceptance admission enum kept: different shape, not
  a duplicate; `NoEffects` consolidation rides the card-209 gate framework

## Evidence

- pure type consolidation, no serialized formats touched
- `cargo check --workspace` and `cargo test --workspace` green (real exit
  codes)

## Next

Card 209: generic admission/diagnostics gate framework over this
vocabulary, then migrate the `provider_live_read_admission` family off the
stamped 5-file kits.
