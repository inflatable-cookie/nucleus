# 041 Operation Catalogue Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../013-cross-panel-operation-catalogue.md`
Depends on: card 040
Auto-start next card: yes

## Objective

Close cross-panel operation behavior across races, retry lineage, restart, and
native presentation.

## Acceptance

- [x] progress, completion, failure, interruption, cancellation, and retry are honest
- [x] retry lineage does not mutate terminal ancestors
- [x] bounded recent retention and teardown pass
- [x] no duplicate durable authority is active

## Validation

- [x] focused Rust, desktop, Svelte, and native operation checks pass

## Stop Conditions

- stop on ambiguous cancellation or terminal-state ownership
