# 081 Shell Quality Acceptance

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 080
Auto-start next card: no

## Objective

Close semantic interaction, panel responsiveness, and bounded recovery with
deterministic and isolated native evidence.

## Acceptance

- [x] keyboard-only shell navigation and rename pass
- [x] narrow panel composition passes inside a wide window
- [x] primary actions remain visible without normal-chrome horizontal scroll
- [x] loading, empty, failure, retry, and recovery transitions are announced correctly
- [x] exact retry and project-switch isolation pass

## Validation

- [x] focused Bun, mounted Vitest, Svelte, desktop build, docs, and diff checks pass
- [x] isolated native evidence is recorded

## Stop Conditions

- authenticated provider work and remote host effects retain separate gates

## Evidence

- Desktop validation passes 57 Bun fixtures and 23 mounted Vitest fixtures.
- Svelte reports zero errors and zero warnings; the production desktop build and
  Rust check pass.
- An isolated fixture-backed native launch at the 900 by 680 supported minimum
  exposes semantic project controls, Agent Chat controls, Tasks refresh, and the
  Tasks empty state without normal-chrome horizontal scrolling.
- No authenticated provider work or remote host effect ran.
