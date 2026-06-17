# 202 Add Filesystem Sanitized Artifact Metadata Store

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add filesystem-backed storage for sanitized artifact metadata.

## Scope

- Store sanitized metadata under the server state root.
- Store refs for bounded text artifacts.
- Reject secret material and raw output by default.

## Out Of Scope

- Remote object storage.
- Full artifact browser UI.
- Process spawn.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- Metadata round-trip is tested.
- Raw output is not stored by default.
- Storage path stays under the configured state root.
