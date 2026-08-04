# 079 Shell State Presentation

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 078
Auto-start next card: yes

## Objective

Converge workspace and sidebar loading, empty, failure, and retry composition
without creating global status chrome.

## Acceptance

- [x] shell and sidebar state uses current Poodle loading and empty primitives where they fit
- [x] actionable failures expose alert semantics and an exact local retry
- [x] loading and successful refresh use polite status semantics
- [x] retained failure copy does not repeatedly announce on ordinary rerender
- [x] healthy state stays quiet

## Validation

- [x] mounted state-transition, announcement, retry, and project-switch fixtures pass

## Stop Conditions

- do not turn local read failures into retained global notifications
- do not add fallback project, resource, provider, or panel selection

## Evidence

- Project and Threads reads expose local alerts and exact Retry controls.
- Startup and retained-layout failure stays with the workspace stage; loading
  and count changes use polite status semantics.
- Mounted Project Rail and Memory fixtures cover retry and project replacement
  without adding global status chrome.
