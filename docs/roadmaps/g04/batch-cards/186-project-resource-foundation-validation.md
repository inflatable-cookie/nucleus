# 186 Project Resource Foundation Validation

Status: completed
Owner: Codex
Updated: 2026-07-15
Milestone: `../037-project-resource-foundation.md`
Auto-start next card: no

## Objective

Validate resource schema migration, host authority, control serialization, and
zero-to-many resource invariants before project controls consume them.

## Acceptance

- focused Rust migration and domain tests pass
- control-envelope round trips cover every initial resource shape
- repo scans confirm operational callers no longer depend on lossy storage data
- docs QA and formatting pass

## Stop Conditions

- `primary_location` remains the only executable workspace target
- a resource-free project cannot be loaded from storage

## Outcome

Focused domain, migration, server, desktop-host, and workspace checks pass.
Control-envelope round trips cover resource-free projects plus folder and Git
resources in working, management, and reference roles across local and remote
authority hosts. Serialization tests prove host-private resource material does
not cross the client boundary, and unknown resource kinds fail closed.

Operational chat and editor file callers now resolve the nominated resource
record and its host-local locator. The legacy `primary_location` summary
remains only inside schema-v1 migration and storage compatibility tests.
