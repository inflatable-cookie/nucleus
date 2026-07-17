# Provider No-Effects Pilot

Date: 2026-07-17
Lane: g04 admission vocabulary consolidation (card 209, first batch)

## Outcome

- added `nucleus-server::provider_no_effects::ProviderNoEffects`: the
  standard eight "nothing executed" booleans as one shared struct with
  `#[serde(flatten)]` embedding, so DTO wire shapes keep their flat field
  names while Rust structs stop stamping the block
- migrated the `provider_live_read_admission` family's standard blocks:
  struct declarations, all-false constructor blocks, copy-style
  diagnostics-to-DTO blocks, and 38 field-access/assert sites (fixed
  compiler-driven from E0609 errors)
- workspace-wide `executed: false` literals: 1538 -> 1483; the family's
  execution/ subtree uses variant field sets and stays for the next batch

## Evidence

- `cargo test -p nucleus-server` and `cargo test --workspace` green (real
  exit codes)
- serde flatten keeps JSON keys unchanged; existing DTO serialization tests
  pass unmodified

## Next

Continue card 209: execution/ subtree variant blocks, then sweep the
remaining provider families with the same script; then the
AdmissionRecord/blocker framework so a new gate is one file plus data.
