# Cross-Panel Operation Catalogue

Date: 2026-08-02
Cards: g05.039-g05.041

## Result

The desktop host owns one bounded Longhorn operation catalogue. Forge inspect,
staging, and commit commands publish typed running and terminal summaries.
Resource import, indexing, and recovery kind ids are reserved for their owning
lanes. The renderer can observe, select, and dismiss retained terminal records;
it cannot register or advance host work.

The titlebar shows a compact operations affordance only while active or recent
work exists. Leaving Forge or switching projects does not hide host work.
Renderer teardown stops observation without cancelling execution.

## Boundary

The catalogue contains operation id, product-owned kind, optional project
scope, bounded label, generic progress, cancellation capability, and terminal
state. Paths, fingerprints, receipts, provider data, Tasks, plans, questions,
transcripts, and durable recovery evidence remain outside it.

## Evidence

- operation authority, exclusion, redaction, sticky terminal, and unauthorized
  renderer Rust fixtures: passed
- compact operation presentation fixtures: passed
- Svelte check: zero errors; one pre-existing ProjectRail accessibility warning
- native desktop compilation and prior exact-package launch smoke: passed
