# 209 Provider Gate Framework Migration

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../045-admission-vocabulary-consolidation.md`
Auto-start next card: no

## Objective

Collapse the stamped provider admission kits (types / blockers /
record_builder / diagnostics / persistence per feature) onto a generic gate
framework.

## Steps

- build `AdmissionRecord<Domain>` / generic blocker evaluation / generic
  diagnostics over the card-208 vocabulary
- migrate provider gates in batches, deleting per-feature kits as they
  convert; track module-count delta per batch
- keep DTO wire compatibility for existing queries or version them
  deliberately

## Acceptance

- [ ] at least the `provider_live_read_admission` family migrated end to end
- [ ] each migrated gate is one file plus data
- [ ] server top-level module count reduced and recorded

## Validation

- `cargo test -p nucleus-server`
- cold `cargo check -p nucleus-server` timing before/after recorded

## Stop Conditions

- stop and reassess if migration forces wire-format breaks desktop cannot
  absorb in the same batch
