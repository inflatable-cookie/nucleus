# 208 Shared Admission And Evidence Vocabulary

Status: planned
Owner: Codex
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

- [ ] shared vocabulary exists with docs and tests
- [ ] domain crates consume it; duplicate definitions deleted
- [ ] no behavior change (pure type consolidation)

## Validation

- `cargo test --workspace`

## Stop Conditions

- stop before touching serialized wire formats without a compat note
