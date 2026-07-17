# Admission Gate Framework

Date: 2026-07-17
Lane: g04 admission vocabulary consolidation (card 209 closeout)

## Outcome

- `nucleus-server::admission_gate`: `AdmissionGate` trait (input, blocker,
  status, no-effects types + pure `blockers`/`classify`), `admit()` runner,
  and `count_by_status` replacing per-family count helpers
- live-read admission implemented through the framework as the reference
  gate (`provider_live_read_admission/gate.rs`) with a test proving
  equivalence to the family's own blocker/status logic
- contract 018 gained the Admission Gate Framework Rule: new gates are one
  trait impl in one file; no new stamped kits; no private no-effects
  boolean blocks; shared serde-flattened no-effects structs only
- no-effects consolidation across three sweeps: six shared structs,
  `executed: false` literals 1538 -> 802; remaining tails are small
  per-family variants left until those files are next touched

## Evidence

- workspace tests and docs QA green; CI green on prior sweeps
- equivalence test pins framework output to existing family logic

## Next

Card 210: nucleusd typed_response collapse plus tautological test pruning —
the last card in milestone 045.
