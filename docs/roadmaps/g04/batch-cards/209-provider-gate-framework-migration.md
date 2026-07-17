# 209 Provider Gate Framework Migration

Status: in progress
Owner: Claude
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

- [x] shared `ProviderNoEffects` (serde-flattened, wire-identical) landed;
  all standard 8-boolean blocks in the `provider_live_read_admission`
  family converted (struct decls, constructors, 38 access sites,
  compiler-driven)
- [x] second sweep: `ProviderRuntimeNoEffects` (the
  `provider_effect_executed` variant) + remaining standard blocks across 44
  more server files, 104 server access sites, nucleusd renderers and test
  fixtures; `executed: false` count 1538 -> 1228
- [x] third sweep: ConvergenceSnapNoAuthority, ConvergenceRunnerNoAuthority,
  MemoryApplyNoEffects, ForgeScmNoEffects across 123 server files + app
  fixtures; `executed: false` count now 802 (from 1538)
- [ ] remaining tails (small subset blocks, request-flag inputs, per-family
  one-offs) — final cleanup batch, then the AdmissionRecord framework
- [ ] each migrated gate is one file plus data (needs the
  AdmissionRecord/blocker framework beyond NoEffects)
- [ ] server top-level module count reduced and recorded

## Validation

- `cargo test -p nucleus-server`
- cold `cargo check -p nucleus-server` timing before/after recorded

## Stop Conditions

- stop and reassess if migration forces wire-format breaks desktop cannot
  absorb in the same batch
