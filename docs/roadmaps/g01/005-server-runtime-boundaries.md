# 005 Server Runtime Boundaries

Status: active
Owner: Tom
Updated: 2026-06-16

## Goal

Define server runtime effect traits, state, events, replay, retention, storage,
subscriptions, transport selection, auth, secrets, credential readiness,
command readiness, and artifact retention before runtime implementation starts.

## Scope

- Runtime effect trait boundary.
- Runtime effect state machine and event vocabulary.
- Replay, retention, storage, query, subscription, and transport boundaries.
- Client auth and pairing.
- Secret store and credential material.
- Credential resolution and command runner readiness.
- Command artifact store and output retention boundary.

## Out Of Scope

- Runtime scheduler implementation.
- Event bus implementation.
- Persistence backend selection.
- Network transport implementation.
- Auth implementation.
- Secret backend implementation.
- Command execution implementation.
- Artifact store implementation.

## Execution Plan

- [x] Define runtime effect traits, state machine, and event vocabulary.
- [x] Define replay, retention, storage, query, subscription, and transport
  boundaries.
- [x] Define client auth, pairing, secret material, and credential readiness.
- [x] Define command runner and sandbox readiness.
- [x] Define command artifact store and output retention boundary.
- [x] Normalize remaining server/runtime research gaps into implementation
  blockers versus implementation-phase decisions.
- [ ] Compile the first implementation runway inside `g01`.

## Acceptance Criteria

- [x] Runtime effects have type-only Rust surfaces with no scheduler.
- [x] Replay and subscriptions have server-owned identity and ordering
  vocabulary with no transport implementation.
- [x] Client auth is separate from command approval and credentials.
- [x] Credential readiness is separate from credential resolution.
- [x] Command readiness is separate from command execution.
- [x] Artifact retention policy prevents raw output from entering normal
  evidence, task history, journals, or logs by default.
- [x] Remaining foundation gaps are sorted before implementation starts.

## Implementation Gap Classification

Foundation blockers before the first implementation runway:

- choose the first implementation slice and acceptance tests
- decide which runtime subsystems stay type-only for that slice

First implementation decisions:

- server-local storage backend and serialization format
- minimal server command/event/state persistence
- local-only control API transport
- local-only auth posture
- first restart-recovery path
- first implementation test strategy

Deferred subsystem decisions:

- LAN/internet auth and pairing
- live subscriptions and backpressure
- command runner and sandbox backends
- artifact payload backend
- secret backend and user prompting
- Tauri control plane behavior
- text/code editor substrate, language-server lifecycle, theme import, and
  plugin host split
- SCM changes/diff/commit controls and AI proposal workflows

## Cards

- `docs/roadmaps/g01/batch-cards/045-draft-runtime-effect-trait-boundary.md`
- `docs/roadmaps/g01/batch-cards/046-add-runtime-effect-trait-skeleton.md`
- `docs/roadmaps/g01/batch-cards/047-draft-runtime-effect-state-machine-policy.md`
- `docs/roadmaps/g01/batch-cards/048-add-runtime-effect-state-types.md`
- `docs/roadmaps/g01/batch-cards/049-draft-runtime-effect-event-vocabulary.md`
- `docs/roadmaps/g01/batch-cards/050-add-runtime-effect-event-types.md`
- `docs/roadmaps/g01/batch-cards/051-draft-runtime-effect-replay-and-retention-policy.md`
- `docs/roadmaps/g01/batch-cards/052-add-runtime-effect-replay-retention-policy-types.md`
- `docs/roadmaps/g01/batch-cards/053-draft-runtime-effect-storage-boundary.md`
- `docs/roadmaps/g01/batch-cards/054-add-runtime-effect-storage-boundary-types.md`
- `docs/roadmaps/g01/batch-cards/055-draft-runtime-effect-replay-query-boundary.md`
- `docs/roadmaps/g01/batch-cards/056-add-runtime-effect-replay-query-types.md`
- `docs/roadmaps/g01/batch-cards/057-draft-runtime-effect-subscription-boundary.md`
- `docs/roadmaps/g01/batch-cards/058-add-runtime-effect-subscription-types.md`
- `docs/roadmaps/g01/batch-cards/059-draft-runtime-effect-transport-selection-boundary.md`
- `docs/roadmaps/g01/batch-cards/060-add-runtime-effect-transport-types.md`
- `docs/roadmaps/g01/batch-cards/061-draft-client-auth-and-pairing-boundary.md`
- `docs/roadmaps/g01/batch-cards/062-draft-secret-store-and-credential-material-boundary.md`
- `docs/roadmaps/g01/batch-cards/063-draft-credential-resolution-integration-policy.md`
- `docs/roadmaps/g01/batch-cards/064-draft-credential-resolution-runtime-readiness.md`
- `docs/roadmaps/g01/batch-cards/065-draft-command-runner-and-sandbox-runtime-readiness.md`
- `docs/roadmaps/g01/batch-cards/066-draft-command-artifact-store-and-output-retention-boundary.md`

## Current Ready Card

- `docs/roadmaps/g01/batch-cards/068-compile-first-implementation-runway.md`

## Planning Gaps

- First implementation slice and acceptance tests.
- Initial local storage/backend choice for the first slice.
- Initial local control API transport choice for the first slice.
- Initial local auth posture for the first slice.
