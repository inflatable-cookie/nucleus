# 081 Add Local Server State Service Facade

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add the first server-owned state service facade over `nucleus-local-store`.

## Scope

- Add a modular server crate boundary for local state service composition.
- Wrap local-store repositories behind server-owned service types.
- Keep service methods narrow and domain-oriented.
- Include project, task, workspace, adapter registry, session, route, event,
  command evidence, artifact metadata, and runtime effect metadata access.
- Preserve backend-adapter storage posture.
- Add unit tests around service construction and simple domain access.

## Out Of Scope

- Network API.
- Tauri client calls.
- Auth.
- Runtime scheduler.
- Command execution.
- Live subscriptions.
- Provider adapters.
- Postgres backend.

## Evidence Questions

- Should the facade live in `nucleus-server` or a new crate?
- Which service boundaries should exist before command/query API types?
- How much local-store detail may leak through server-owned services?
- Which domains need read-only access first versus mutation methods?

## Stop Conditions

- The card starts a network server.
- The card lets clients use storage repositories directly as the API.
- The card introduces command execution or provider process lifecycle.
- The card pushes large unrelated types into `lib.rs`.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-local-store`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`

## Validation

```sh
cargo test --workspace
effigy qa:docs
effigy qa:northstar
```

## Decisions

- The facade lives in `nucleus-server` as `state.rs`.
- `nucleus-server` depends on `nucleus-local-store` for backend adapter and
  repository vocabulary.
- The first facade is generic over `LocalStoreBackend`; it does not assume
  SQLite in production code.
- Domain accessors expose project, task, workspace, adapter registry, agent
  session, model route, event journal, command evidence, artifact metadata,
  and runtime effect metadata records.
- Repository handles are opened per operation and are not exposed as the
  control boundary.

## Closeout

`nucleus-server` now has `ServerStateService`, `ServerStateDomain`, and
`ServerStateDomainService` as a transport-free local state facade over
backend-adapter storage.

Tests cover backend descriptor access, project create/read/list through the
facade, revision checks, and descriptor access across all first facade domains.
No network API, Tauri call path, auth, scheduler, command execution, live
subscription, provider adapter, or Postgres behavior was introduced.
