# 192 Define First Local Artifact Store Backend Slice

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define the first concrete local artifact store backend slice.

## Scope

- Pick the first storage location and payload classes.
- Define retention and redaction evidence refs.
- Keep raw payload policy explicit.

## Out Of Scope

- Full artifact browser UI.
- Remote object storage.
- Secret material storage.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-server`

## Acceptance Criteria

- First artifact store backend slice is narrow.
- Sanitized metadata and payload refs remain separate.
- Spawn remains blocked without the other required backends.

## Closeout

- First artifact store slice is filesystem-backed under the server state root.
- First payload classes are sanitized summary and validation report refs.
- Retention evidence and redaction evidence remain separate.
- Raw output and secret material stay out of default storage.
