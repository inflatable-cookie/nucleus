# Project Resource Domain And Storage

Date: 2026-07-15
Lane: g04 project resource foundation

## Outcome

- replaced the repo-only project domain with zero-to-many project resources
- added folder and Git resource kinds plus working, management, and reference
  roles
- added transient/durable retention, working defaults, and management targets
- added storage schema v2 with full locator, Git, host, and repair metadata
- migrated schema-v1 display records on decode without changing project ids
- changed filesystem callers to derive their current root from resource state
- kept current project display DTO fields as derived hints only

## Evidence

- 1,837 focused project, engine, server, SCM, and desktop tests pass
- the final project, engine, and server run passes 1,764 tests
- isolated `cargo check --workspace` passes
- future project storage schema versions fail closed

The legacy schema stored only repo count, one path, and aggregate health. The
migration preserves all information that existed there; full Git and repair
metadata is retained by schema v2 going forward.

## Next

Add resource-aware server read models and mutation admission. Do not add
project-management UI until the server control boundary is complete.
