# 024 Projection Schema Validation And Migration Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft projection schema validation and migration policy.

## Scope

- Define first-pass projection schema validation rules.
- Define how unsupported schema versions should be reported.
- Define migration posture before projection IO exists.
- Define where validation belongs in future crate boundaries.
- Keep serialization and file IO implementation out of scope.

## Out Of Scope

- Implementing validators.
- Implementing migrations.
- Choosing TOML parsing libraries.
- Implementing Git sync.
- Writing projection files.

## Evidence Questions

- Should invalid projection records block import or become repair tasks?
- Which validation failures are semantic conflicts versus schema errors?
- Should old schema records be read-only until migrated?
- Which migrations can be mechanical?
- Where should validation evidence be recorded?

## Stop Conditions

- Validation policy starts implementing parser behavior.
- Migration policy silently rewrites shared records.
- Unsupported records are ignored.
- Schema validation is treated as Git conflict resolution.

## Promotion Targets

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- future projection validation crate or module plan

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge conflict and review workflow policy.
