# Swallowtail Idioms Route Opt-In Adoption

Date: 2026-08-09

## Outcome

Nucleus adopts the Swallowtail Contract 056 route-path idioms opt-in as the
testbed consumer.

- swallowtail deps move from immutable tag `v0.3.1` to pinned rev
  `1b19ccfe63c56b710e26192df41bc5e406974658` (unreleased current source that
  contains the opt-in surface; a later source release restores tag pinning)
- `swallowtail-idioms` joins `nucleus-agent-adapters` dependencies
- `CodexHost` gains the registration seam `with_idiom_source`, chained into
  `services()` alongside the debug observer
- deterministic fixture proves folded delivery on Nucleus session types:
  consumer instructions stay first, the labeled `[idioms]` block appends,
  and a missing opt-in produces no idioms work

## Boundary

- production task execution is unchanged: no opt-in field is set until the
  Nucleus product wires a rules store into the registration seam
- `nucleus-agent-protocol` and `nucleus-server` only moved their dep pins;
  no behavior change
- no product semantics invented: the seam is mechanism, rule content stays
  product-owned

## Validation

- focused `nucleus-agent-adapters` nextest suite: 28 passed, 2 skipped
- `nucleus-agent-protocol` and `nucleus-server` compile on the pinned rev
- the pre-existing `large_enum_variant` clippy finding in
  `nucleus-agent-protocol` remains untouched and unrelated
