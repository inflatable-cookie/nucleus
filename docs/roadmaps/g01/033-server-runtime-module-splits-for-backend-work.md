# 033 Server Runtime Module Splits For Backend Work

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Split oversized server runtime readiness modules before concrete backend
implementation starts.

## Scope

- Split host-spawn readiness tests and helpers out of the main module.
- Split local host runtime discovery fixtures and tests away from core
  vocabulary where useful.
- Keep public exports stable inside the pre-implementation workspace.
- Re-run focused and workspace validation.

## Out Of Scope

- Implementing process spawn.
- Implementing backend IO.
- Desktop UI.

## Decisions

- Backend implementation should not be layered into god-file modules.
- `host_spawn_readiness.rs` is the first split target because it is already a
  doctor error and sits on the next backend path.
- Splits should preserve behavior and public names.
- Runtime backend path files are no longer high-severity god-file findings.
- Remaining high god-file findings are outside this lane:
  `apps/nucleusd/src/main.rs` and
  `crates/nucleus-command-policy/src/storage_codec.rs`.

## Execution Plan

- [x] Split host-spawn readiness tests into a sibling module.
- [x] Split reusable host-spawn readiness fixtures into a sibling module.
- [x] Split local host runtime discovery tests and fixtures where it reduces
  module growth.
- [x] Reassess god-file findings for backend-readiness files.
- [x] Repoint next lane to artifact-store backend implementation.

## Acceptance Criteria

- [x] `host_spawn_readiness.rs` drops below the god-file error threshold.
- [x] Public server exports remain stable.
- [x] Focused and workspace tests pass.
- [x] Next lane can start local artifact-store backend implementation.

## Cards

- `docs/roadmaps/g01/batch-cards/196-split-host-spawn-readiness-tests.md`
- `docs/roadmaps/g01/batch-cards/197-split-host-spawn-readiness-fixtures.md`
- `docs/roadmaps/g01/batch-cards/198-split-local-host-runtime-discovery-tests.md`
- `docs/roadmaps/g01/batch-cards/199-reassess-runtime-god-file-findings.md`
- `docs/roadmaps/g01/batch-cards/200-repoint-to-artifact-store-backend-implementation.md`

## Closeout

- `host_spawn_readiness.rs` is split into production logic, test fixtures, and
  tests.
- `local_host_runtime_discovery.rs` is split into production vocabulary and
  tests.
- Focused runtime tests pass after the split.
- God-file scan no longer reports backend-readiness files as high severity.
- `effigy doctor` still fails on unrelated high findings in `apps/nucleusd` and
  `nucleus-command-policy` storage codec.
