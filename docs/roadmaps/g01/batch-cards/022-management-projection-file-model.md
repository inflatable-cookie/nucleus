# 022 Management Projection File Model

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft management projection file model.

## Scope

- Choose the first candidate repo projection root.
- Define first-pass project metadata record shape.
- Define first-pass task record file shape.
- Define stable ids, filenames, path history, and repair metadata.
- Define which runtime, provider, cache, and secret fields are excluded.
- Promote durable rules into SCM, project, and task contracts.

## Out Of Scope

- Implementing file IO.
- Implementing Git sync.
- Implementing migrations.
- Choosing a final serialization library.
- Building UI for task files.

## Evidence Questions

- Should the projection root be visible by default?
- Should task records be one file per task from the start?
- Which fields must be committed for multi-user collaboration?
- Which fields must remain server-local?
- How should schema version and record revision be represented?
- How should moved repos and missing paths be represented without breaking
  project identity?

## Stop Conditions

- Live runtime state is placed in the repo projection.
- Secrets or provider auth material are allowed in projection files.
- Tasks are represented only as one large shared document.
- The projection file model replaces the server's active working set.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- future Rust projection/storage crate or module plan

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
