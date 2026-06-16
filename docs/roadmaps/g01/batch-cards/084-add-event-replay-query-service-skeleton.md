# 084 Add Event Replay Query Service Skeleton

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add a testable event replay/query service skeleton over stored event metadata.

## Scope

- Query persisted event journal records by cursor or time window.
- Keep replay read-only.
- Return metadata refs without resolving secrets, artifacts, or raw provider
  transcripts.
- Add tests that replay survives store restart.

## Out Of Scope

- Live subscriptions.
- Event fanout.
- Runtime effect execution.
- Provider transcript storage.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-local-store`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Replay service code lives in `nucleus-server/src/event_replay.rs`.
- The service reads through `ServerStateService`; it does not use local-store
  repositories directly as a client API.
- First supported scopes are all events and events after a cursor.
- Runtime effect metadata may be included as retained metadata records.
- Time-window query shape is named, but currently returns unsupported until
  event timestamps are indexed.

## Closeout

Added `ServerEventReplayService` plus replay query, window, response, status,
and error vocabulary.

Tests cover restart recovery, cursor/limit behavior, and explicit unsupported
time-window replay. No live subscriptions, event fanout, runtime effect
execution, provider transcript storage, artifact payload resolution, secret
resolution, scheduler, or network transport was added.
