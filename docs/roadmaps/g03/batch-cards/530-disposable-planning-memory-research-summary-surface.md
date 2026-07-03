# 530 Disposable Planning Memory Research Summary Surface

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../121-disposable-planning-research-ui-proof.md`

## Purpose

Expose read-only summaries for planning sessions, memory proposals, and
research run briefs in the disposable proof surface.

## Work

- [x] Reuse existing server query paths for planning sessions.
- [x] Reuse existing server query paths for memory proposals.
- [x] Reuse existing server query paths for research run briefs.
- [x] Render summaries only; no review, accept, apply, execute, or promote
  controls.

## Acceptance Criteria

- [x] The proof shows all three read models together.
- [x] Raw payloads, source bodies, private notes, provider payloads, and secret
  material are not exposed.
- [x] No mutation or execution path is added.

## Evidence

- `PlanningResearchProofPanel.svelte` renders the three read models together.
- `cargo test -p nucleus-desktop planning -- --nocapture` passed.
- `cargo test -p nucleus-desktop panel -- --nocapture` passed.
- `cd apps/desktop && bun run check` passed.
- `cd apps/desktop && bun run build` passed.
