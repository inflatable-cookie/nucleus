# 075 Memory Provider Control Acceptance

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../023-memory-provider-and-advanced-control-cohesion.md`
Depends on: card 074
Auto-start next card: no

## Objective

Close Memory, provider selection, session defaults, and advanced-control
placement with deterministic and isolated native evidence.

## Acceptance

- [x] Memory content and redaction survive project switch and restart
- [x] accepted and proposed state remains distinct and read-only
- [x] provider and route changes replace sessions without rewriting existing history
- [x] unsupported providers and credential actions fail honestly
- [x] narrow layouts retain every primary action without permanent diagnostic chrome

## Validation

- [x] focused Rust, Bun, mounted, Svelte, docs, and diff checks pass
- [x] isolated native evidence is recorded

## Stop Conditions

- authenticated provider and credential effects retain separate operator gates

## Evidence

- accepted Memory is reopened from a fresh SQLite backend and compared without
  projection drift; mounted project switching preserves the correct project
  context and redaction.
- route fixtures reject unknown, not-ready, stale-revision, and facade-mismatched
  selections. Exact route changes require a fresh session while stored history
  remains conversation evidence.
- deterministic one-ready, two-ready, blocked-provider, duplicate-model-id,
  unavailable credential-action, and reset/restart fixtures pass.
- focused Rust, Bun, mounted Vitest, Svelte, desktop build, docs, formatting,
  and diff checks pass. No authenticated provider or credential effect ran.
