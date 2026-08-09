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

## AGENTS.md Workflow Wiring

The product workflow now activates idioms when a project has an `AGENTS.md`:

- `nucleus-agent-protocol::TaskExecutionRequest` carries `idioms_enabled`
- the Codex adapter parses `<project_root>/AGENTS.md` into Project-scoped
  static idioms (`swallowtail_codex/idioms.rs`): sections and bullets,
  code fences skipped, capped at 8 in file order, full confidence, static
  provenance
- when enabled, the task path registers the source on `HostServices` and
  sets the session opt-in; sessions then receive the folded `[idioms]`
  block after Nucleus's developer instructions
- the server task chain defaults `idioms_enabled: true` ("use AGENTS.md by
  default if it exists")

## Pending

- composer toggle: threads `idioms_enabled` through the control surface and
  the chat composer UI (session-scoped: bound at session open, takes effect
  on the next session)
- memory as secondary source: memory records join the same source once the
  memory system is implemented
- oversight-agent signals: accept/reject/edit recording lands with the
  designated oversight agent (cheap-model quick-chat / title generation)

## Validation

- focused `nucleus-agent-adapters` nextest suite: 31 passed, 2 skipped
- `nucleus-server` suite: 2067 passed, 14 skipped
- `nucleus-agent-protocol` and `nucleus-server` compile on the pinned rev
- the pre-existing `large_enum_variant` clippy finding in
  `nucleus-agent-protocol` remains untouched and unrelated
