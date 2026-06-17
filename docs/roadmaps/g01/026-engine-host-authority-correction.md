# 026 Engine Host Authority Correction

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Correct the architecture from server-first to engine-first with explicit host
forms and project authority maps.

## Scope

- Promote engine-first / host-flexible architecture.
- Add durable host authority contract.
- Reinterpret server APIs as host APIs where needed.
- Define project authority domains.
- Pause runtime lanes that assume one global server authority.

## Out Of Scope

- Renaming crates.
- Refactoring Rust code.
- Implementing embedded Tauri engine hosting.
- Implementing binary remote protocol.
- Implementing host registry or authority-map persistence.

## Decisions

- The Rust engine is the system core.
- A server is a host form, not the core itself.
- Embedded desktop host is the preferred local single-user posture.
- `nucleusd` remains useful for local sidecar, remote authoritative, and
  worker/proxy deployments.
- Host connection does not imply project authority.
- Projects need explicit authority maps by domain.

## Execution Plan

- [x] Normalize engine host authority docs.
- [x] Update server/storage/project contracts for host authority wording.
- [x] Add architecture inventory notes for current crate naming.
- [x] Replan paused runtime lane from host-authority model.

## Acceptance Criteria

- [x] Architecture front door no longer says Nucleus is server-first.
- [x] Host forms and authority domains are documented.
- [x] Server contracts no longer imply one global server owns every project.
- [x] Runtime next task is replanned from the host-authority model.

## Cards

- `docs/roadmaps/g01/batch-cards/164-normalize-engine-host-authority-docs.md`
- `docs/roadmaps/g01/batch-cards/165-update-server-storage-project-authority-wording.md`
- `docs/roadmaps/g01/batch-cards/166-add-current-crate-naming-inventory-note.md`
- `docs/roadmaps/g01/batch-cards/167-replan-runtime-lane-from-host-authority.md`

## Closeout

The correction is promoted. Runtime process-supervisor work remains paused.
The next narrow lane is host authority-map vocabulary.
