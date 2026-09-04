# Swallowtail v0.4 Candidate Adoption

Date: 2026-09-04

## Outcome

Nucleus adopts immutable Swallowtail candidate
`56f3913ac99af44b6ff45384cfc53a0adea587ba` before the `v0.4.0` tag.

- all five Swallowtail dependencies resolve from that exact revision
- every interactive-session close supplies the selected host services and a
  fresh deadline derived from the operation timeout
- missing host time produces a fail-closed cleanup request rather than a panic
- the new portable `HostWatcher` activity kind persists as `host_watcher`

The pin remains a revision until Swallowtail cuts the reviewed annotated tag.
Moving it to `v0.4.0` requires a later dependency-only verification after the
tag peels to this candidate tree.

## Boundary

This change adapts Nucleus to Swallowtail's public `v0.4.0` candidate. It does
not change Agent Chat policy, prompts, tools, credential ownership, provider
selection, or application state. The authenticated product smoke remains a
separate post-merge release proof.

## Validation

- `nucleus-agent-adapters`: 32 passed, 2 authenticated tests ignored
- focused `nucleus-server` Agent Chat surface: 91 passed, 14 authenticated
  tests ignored
- changed Rust packages compile on the declared Rust 1.95 floor
- the full workspace check reaches the desktop crate, then stops because the
  generated `apps/desktop/dist` prerequisite is absent
