# 070 Terminal Browser Resource Acceptance

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../022-terminal-browser-resource-host-cohesion.md`
Depends on: card 069
Auto-start next card: no

## Objective

Close Terminal, Browser, resource-target, and host-status cohesion across
deterministic and isolated native desktop paths.

## Acceptance

- [x] zero-resource Terminal uses only the authoritative host fallback
- [x] sole, multiple, broken, and non-local target states render honestly
- [x] Terminal attach, remount, target change, and retry preserve identity
- [x] Browser active, hidden, overlay, failed-start, and retry states remain safe
- [x] project switch and restart preserve layout and target choices

## Validation

- [x] focused Rust, Bun, mounted, Svelte, docs, and diff checks pass
- [x] isolated native evidence is recorded

## Stop Conditions

- remote transport and authenticated provider work require their existing gates

## Evidence

- shared target projection Bun fixtures cover zero, sole, multiple, broken,
  and exact explicit targets without list-order fallback
- server fixtures reject remote authority before path access and admit the
  local host fallback only for a local resource-free project
- Terminal presentation fixtures keep the healthy embedded path quiet and
  distinguish opening, retryable failure, live-session failure, and confirmed
  non-local host evidence
- 49 Bun tests, 18 mounted desktop tests, 11 desktop panel guards, 8 resource
  target tests, and 6 Terminal runtime tests pass
- Svelte, desktop production build, Rust workspace check, docs QA, formatting,
  and diff hygiene pass
- the isolated current native bundle switched Browser -> Terminal -> Browser,
  rendered live Terminal output on the theme canvas, retained the Browser
  child, exposed the toolbar menu above Browser content, and restored the
  selected Browser after a full app restart
- authenticated provider work was not run; remote Terminal transport remains
  behind its existing gate
