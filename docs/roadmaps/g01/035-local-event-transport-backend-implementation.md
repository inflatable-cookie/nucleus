# 035 Local Event Transport Backend Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Implement the first local event transport backend slice for command supervision
events.

## Scope

- Add local event transport backend implementation boundary.
- Model in-process delivery for supervision event kinds needed by spawn
  readiness.
- Keep replay tied to existing server event/effect vocabulary.
- Compose event transport readiness into local runtime discovery.
- Keep process spawn out of scope.

## Out Of Scope

- Remote streaming transport.
- WebSocket or HTTP event transport.
- Process spawn.
- Full replay store implementation beyond readiness evidence.
- Desktop UI.

## Decisions

- Event transport follows artifact store because command execution evidence now
  has somewhere safe to point artifact metadata refs.
- First transport is in-process and local-only.
- Delivery and replay evidence refs must remain separate.
- The transport boundary must not imply sandbox or process-control readiness.

## Execution Plan

- [x] Add local event transport backend boundary.
- [x] Add in-process supervision event channel vocabulary.
- [x] Add event transport readiness discovery.
- [x] Compose event transport readiness with runtime discovery.
- [x] Reassess sandbox backend implementation readiness.

## Closeout

The first local event transport backend slice is implemented in
`nucleus-server`.

Implemented surface:

- `LocalEventTransportBackend`
- `LocalSupervisionEventChannel`
- `LocalEventTransportChannelId`
- `LocalEventTransportReplayPosture`
- `with_local_event_transport_readiness`

The backend reports concrete in-process readiness for running, terminal, and
cleanup-failed supervision event kinds. Delivery and replay evidence refs stay
separate. Replay is metadata-ref only; no durable replay store or subscription
runtime exists in this slice.

Runtime discovery can now replace the unsupported event transport descriptor
with concrete local readiness. With artifact store and event transport ready,
host-spawn readiness still remains blocked by sandbox and process-control
descriptors.

The next lane is local sandbox backend implementation.

## Acceptance Criteria

- Event transport readiness can be concrete without process spawn.
- Running, terminal, and cleanup-failed supervision event kinds are covered.
- Delivery and replay evidence refs are produced.
- Host-spawn readiness remains blocked by sandbox and process-control
  descriptors.

## Cards

- `docs/roadmaps/g01/batch-cards/206-add-local-event-transport-backend-boundary.md`
- `docs/roadmaps/g01/batch-cards/207-add-in-process-supervision-event-channel-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/208-add-event-transport-readiness-discovery.md`
- `docs/roadmaps/g01/batch-cards/209-compose-event-transport-readiness-with-runtime-discovery.md`
- `docs/roadmaps/g01/batch-cards/210-reassess-sandbox-backend-readiness.md`
