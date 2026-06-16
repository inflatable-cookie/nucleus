# 013 Project State Records And Switcher Readiness

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Prepare enough project state behavior for a useful desktop project switcher.

## Scope

- Define the project record DTO/storage codec boundary.
- Decide how local project seed or creation enters server-owned storage.
- Keep project display data server-owned and control-plane safe.
- Reassess read-only project switcher readiness after project records are
  display-ready.

## Out Of Scope

- Full project settings UI.
- Repo repair UI.
- Task panels.
- Multi-user project sync.
- SCM/forge behavior.

## Decisions

- A project switcher should not render raw opaque storage envelopes as product
  UI.
- The desktop can display project records only after Rust exposes a
  display-ready control DTO or an equivalent server-owned projection.
- Local seed or creation flow must be server-owned; TypeScript must not invent
  project records.
- First project display-data path is a Rust-owned JSON storage codec plus a
  server control DTO/projection.
- First project write path is server-owned local seed data, with full project
  creation commands deferred.
- Local desktop startup now seeds a `Nucleus Local` project through the server
  state path.
- Read-only project switcher is ready because display-ready project records and
  local seed data now exist.

## Execution Plan

- [x] Compile project record DTO and mutation runway.
- [x] Add project record storage codec or projection fixture.
- [x] Add local project seed/create path.
- [x] Reassess read-only project switcher readiness.

## Acceptance Criteria

- [x] Project display fields are available through a server-owned boundary.
- [x] Local storage can contain at least one valid project record through an
  intentional server path.
- [x] Desktop project switcher readiness is explicit.
- [ ] TypeScript remains view glue and does not own project authority.

## Closeout

Project record display and local seed readiness are complete. The next lane can
build a read-only project switcher without adding project mutation behavior.

## Cards

- `docs/roadmaps/g01/batch-cards/114-compile-project-record-and-mutation-runway.md`
- `docs/roadmaps/g01/batch-cards/115-add-project-record-storage-codec-or-fixture.md`
- `docs/roadmaps/g01/batch-cards/116-add-local-project-seed-or-create-path.md`
- `docs/roadmaps/g01/batch-cards/117-reassess-read-only-project-switcher-readiness.md`
