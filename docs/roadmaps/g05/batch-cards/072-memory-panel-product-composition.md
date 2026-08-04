# 072 Memory Panel Product Composition

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../023-memory-provider-and-advanced-control-cohesion.md`
Depends on: card 071
Auto-start next card: no

## Objective

Replace the raw-id-first Memory inspector with a compact project context list
over the exact product display projection.

## Acceptance

- [x] accepted Memory and proposals remain visibly separate
- [x] visible records lead with title, bounded summary, kind, and scope
- [x] redacted records say that content is unavailable without leaking it
- [x] ids, actors, counts, retention, and supersession stay behind a details disclosure
- [x] the tab does not repeat a redundant Memory page title
- [x] loading, empty, unsupported, failure, refresh, project switch, and stale-response behavior remain explicit

## Validation

- [x] focused presentation, mounted desktop, Svelte, and panel-guard checks pass

## Stop Conditions

- no accept, reject, edit, archive, extraction, projection, or provider controls

## Evidence

- `apps/desktop/src/lib/MemoryPanel.svelte` now uses a compact context list
  rather than raw ids as record headings.
- `apps/desktop/src/lib/MemoryPanel.vitest.ts` proves safe content, explicit
  redaction, hidden technical evidence, refresh, and the absent redundant title.
- `effigy desktop:test`, `effigy desktop:check`, `effigy desktop:build`, and
  the native panel guards pass. The existing ProjectRail accessibility warning
  remains outside this card.
