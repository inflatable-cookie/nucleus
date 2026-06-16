# 078 Draft Deep Research Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add first-pass authority surfaces for a deep research system before
server-local storage implementation starts.

## Scope

- Define deep research as server-owned evidence work.
- Support both project-bound and standalone research runs.
- Separate research evidence from accepted planning, task, and memory state.
- Add source records, observations, synthesis, confidence, and gap tracking.
- Update planning, memory, architecture, and storage docs so implementation
  accounts for this domain.

## Out Of Scope

- Crawler implementation.
- Browser automation.
- Search provider selection.
- Vector index implementation.
- Citation renderer.
- Research UI.
- Storage schema implementation.

## Promotion Targets

- `docs/contracts/015-deep-research-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/013-shared-memory-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/roadmaps/g01/006-server-local-state-implementation-runway.md`

## Closeout

Deep research is now documented as a first-class server-owned domain.

The next storage runway can include research record boundaries without
building retrieval, synthesis automation, citation rendering, or UI yet.
