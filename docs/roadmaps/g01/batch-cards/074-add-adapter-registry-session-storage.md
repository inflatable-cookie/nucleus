# 074 Add Adapter Registry Session Storage

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add server-local storage for adapter registry and session records.

## Scope

- Persist adapter registry records.
- Persist agent session records.
- Preserve model-route refs and credential refs without storing material.

## Out Of Scope

- Live adapter runtime behavior.
- Credential lookup.
- Provider calls.

## Validation

```sh
cargo test --workspace
```

## Decisions

- Adapter registry, agent session, and model route records use the same
  backend-adapter repository boundary as project/task/workspace records.
- SQLite gets separate generic tables for adapter instances, agent sessions,
  and model routes.
- Credential refs remain payload-level data. This card does not add credential
  lookup or credential material storage.

## Closeout

`nucleus-local-store` now persists generic adapter registry, agent session, and
model route records through SQLite and the `LocalStoreBackend` /
`LocalStoreRepository` boundary.

No live adapter runtime behavior, credential lookup, provider calls, control
API, backend transaction support, or team-server database backend was
introduced.
