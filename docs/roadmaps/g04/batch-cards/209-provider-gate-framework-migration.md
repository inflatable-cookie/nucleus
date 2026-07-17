# 209 Provider Gate Framework Migration

Status: completed
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
- [x] `AdmissionGate` framework landed (`admission_gate.rs`): trait +
  `admit()` + `count_by_status`; live-read admission stage implemented
  through it as the reference gate with an equivalence test; contract 018
  now mandates the framework for new gates and forbids private no-effects
  boolean blocks
- [x] residuals recorded, deliberately left: ~800 `executed: false`
  literals in small per-family variant blocks (diminishing returns per
  shared struct); existing stamped kits stay until touched — the framework
  stops new stamping, wholesale rewrite of 350 modules is not worth the
  churn risk
- [x] module-count outcome recorded honestly: consolidation added 2 modules
  and removed none — the win is per-change surface (one shared struct edit
  instead of 111 files) and a one-file path for every future gate

## Validation

- `cargo test -p nucleus-server`
- cold `cargo check -p nucleus-server` timing before/after recorded

## Stop Conditions

- stop and reassess if migration forces wire-format breaks desktop cannot
  absorb in the same batch
