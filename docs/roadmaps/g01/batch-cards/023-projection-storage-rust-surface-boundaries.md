# 023 Projection Storage Rust Surface Boundaries

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft projection storage Rust surface boundaries.

## Scope

- Decide whether projection record types belong in `nucleus-core`,
  `nucleus-projects`, `nucleus-tasks`, or a new crate.
- Define descriptive types for projection roots, record ids, schema versions,
  record revisions, and excluded-state policy.
- Keep file IO and Git sync implementation out of scope.
- Connect projection types to project, repo membership, and task contracts.

## Out Of Scope

- Implementing serialization.
- Implementing file IO.
- Implementing Git sync.
- Implementing migrations.
- Implementing schema validation.

## Evidence Questions

- Should projection records be shared core types or domain-specific types?
- Should schema version and record revision live in `nucleus-core`?
- How should excluded-state policy be represented?
- Which crate should later own projection validation?

## Stop Conditions

- Projection types start reading or writing files.
- Serialization format is treated as final.
- Runtime state is modeled as committable projection state.
- Task and project domain boundaries are collapsed into a generic map.

## Promotion Targets

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `crates/nucleus-core`
- `crates/nucleus-projects`
- `crates/nucleus-tasks`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge adapter implementation readiness plan.
