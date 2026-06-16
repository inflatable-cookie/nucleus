# 026 SCM Forge Sync Observation And Task Link Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM/forge sync observation and task-link policy.

## Scope

- Define how SCM and forge observations become server-owned state.
- Define task link semantics for branches, commits, pull requests, issues, and
  comments.
- Separate observations from durable task history and projection records.
- Define webhook and polling refresh boundaries.
- Promote durable rules into the SCM/forge sync and task contracts.

## Out Of Scope

- Implementing observation ingestion.
- Implementing webhook endpoints.
- Implementing forge polling.
- Implementing task-link UI.
- Implementing sync workers.

## Evidence Questions

- Which observations should update project activity?
- Which observations should create task history summaries?
- Which task links are user-authored versus adapter-observed?
- How should duplicate webhook and polling observations be de-duplicated later?
- How should stale forge links be represented?

## Stop Conditions

- Raw webhook payloads become durable task history.
- Observations replace task history.
- Forge issue ids replace task ids.
- Provider refs are discarded.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/005-task-contract.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
