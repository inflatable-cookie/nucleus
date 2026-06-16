# 067 Normalize Server Runtime Implementation Gaps

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Normalize remaining server runtime research gaps into implementation blockers
versus implementation-phase decisions.

## Scope

- Review `007-server-boundary-contract.md`,
  `008-storage-state-persistence-contract.md`, and
  `005-server-runtime-boundaries.md`.
- Classify remaining gaps as foundation blockers, first-implementation
  decisions, or later implementation details.
- Update roadmap 005 with a clear implementation runway.
- Keep `g01` active.

## Out Of Scope

- Runtime implementation.
- Storage backend selection.
- API transport implementation.
- Auth implementation.
- Secret backend implementation.
- Command runner implementation.

## Evidence Questions

- Which gaps still block the first implementation slice?
- Which gaps can be deferred until the relevant subsystem starts?
- Which gaps are already answered by promoted contracts and should be removed?
- What should the first implementation runway build first?

## Stop Conditions

- A new generation is opened.
- Implementation starts before blocker classification is complete.
- Implementation-phase decisions are treated as foundation blockers.
- The roadmap returns to one-card-at-a-time sequencing.

## Promotion Targets

- `docs/roadmaps/g01/005-server-runtime-boundaries.md`
- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
