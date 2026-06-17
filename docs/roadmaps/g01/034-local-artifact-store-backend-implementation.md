# 034 Local Artifact Store Backend Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Implement the first local artifact-store backend slice for sanitized command
evidence refs.

## Scope

- Add local artifact-store backend vocabulary if current descriptors need a
  concrete backend owner.
- Implement filesystem-backed sanitized metadata and bounded text artifact refs
  under the server state root.
- Keep raw output and secret material out of default storage.
- Produce retention and redaction evidence refs for readiness.
- Feed artifact-store backend readiness into discovery and host-spawn gating.

## Out Of Scope

- Real process spawn.
- Remote object storage.
- Artifact browser UI.
- Secret material storage.

## Decisions

- Artifact-store backend implementation comes before event transport, sandbox,
  and process-control implementation.
- First payload classes are sanitized summary and validation report refs.
- Raw stdout/stderr payload storage is not part of the first slice.

## Execution Plan

- [x] Add local artifact-store backend implementation boundary.
- [x] Add filesystem-backed sanitized artifact metadata storage.
- [x] Add artifact-store readiness discovery from backend state.
- [x] Compose artifact-store readiness with unsupported runtime discovery.
- [x] Reassess event transport backend implementation readiness.

## Closeout

The first local artifact-store backend slice is implemented in
`nucleus-server`.

Implemented surface:

- `LocalArtifactStoreBackend`
- `LocalArtifactMetadataStore`
- `LocalArtifactMetadataRecord`
- `with_local_artifact_store_readiness`

The backend reports concrete filesystem readiness after the metadata directory
exists under the server state root. The metadata store writes sanitized JSON
metadata only. It rejects raw process output payload classes and obvious secret
material markers by default.

Runtime discovery can now replace the unsupported artifact-store descriptor
with concrete local readiness. Host-spawn readiness still remains blocked by
sandbox, event transport, and process-control descriptors.

The next lane is local event transport backend implementation.

## Acceptance Criteria

- Artifact-store readiness can be concrete without process spawn.
- Retention and redaction evidence refs are produced.
- Raw output and secret material are not stored by default.
- Host-spawn readiness remains blocked by the other backend descriptors.

## Cards

- `docs/roadmaps/g01/batch-cards/201-add-local-artifact-store-backend-boundary.md`
- `docs/roadmaps/g01/batch-cards/202-add-filesystem-sanitized-artifact-metadata-store.md`
- `docs/roadmaps/g01/batch-cards/203-add-artifact-store-readiness-discovery.md`
- `docs/roadmaps/g01/batch-cards/204-compose-artifact-store-readiness-with-runtime-discovery.md`
- `docs/roadmaps/g01/batch-cards/205-reassess-event-transport-backend-readiness.md`
