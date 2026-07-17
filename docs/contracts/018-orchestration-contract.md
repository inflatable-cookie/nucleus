# 018 Orchestration Contract

Status: draft
Owner: Tom
Updated: 2026-06-17

## Purpose

Define the central command, event, projection, and replay spine for Nucleus.

Nucleus uses event-sourced orchestration for durable work that crosses tasks,
agent sessions, provider runtimes, SCM operations, checkpoints, hosts, and
clients.

Record stores remain useful for projections, indexes, caches, and low-level
domain repositories. They must not become the only source of truth for
orchestrated work.

## Model Decision

Selected model: event-sourced orchestration.

Reason:

- agent runtime streams need durable ingestion and replay
- clients need projections without becoming authorities
- tasks need auditable history without copying raw runtime streams
- host handoff needs a stable event log
- SCM, checkpoint, steward, validation, and research work need shared receipt
  semantics
- provider adapters must not mutate project state directly

## Authority Rule

The authoritative engine host for a domain owns orchestration for that domain.

Clients, adapters, panels, native personas, SCM providers, and background
workers submit commands. The engine validates commands against current
authority, policy, and projection state, then appends accepted events.

Direct record mutation is allowed only for:

- backend migration internals
- fixture setup
- projection rebuild output
- explicitly non-orchestrated local caches

Domain behavior that users can observe or audit must flow through commands and
events once this contract governs that area.

## Command Rule

Commands are requests to change state, start work, stop work, or record an
external observation.

Commands must carry:

- stable command id
- command kind
- requesting client or actor ref
- target authority domain
- target aggregate or workflow ref where known
- idempotency key or duplicate-detection basis
- causal refs where available
- requested policy scope
- submitted timestamp when known

Commands are not events. Rejected commands may produce command receipts, but
must not silently mutate projections.

## Event Rule

Accepted state changes are events.

Events must carry:

- stable event id
- sequence position within the authoritative stream
- event kind
- aggregate or workflow ref
- command id when caused by a command
- actor ref
- authority host ref
- causal refs
- payload schema version
- recorded timestamp

Events are append-only. Corrections are new events, not edits to previous
events, except for storage repair paths that are explicitly out of normal
runtime flow.

## Event Store Envelope Rule

Persisted orchestration events use an orchestration-owned event-store envelope
before they enter host storage adapters.

The first envelope carries:

- event id
- stream ref
- backend-independent cursor
- command id causality
- event kind
- target ref when known
- payload schema version
- projection cursor
- typed orchestration event payload

The envelope and payload must agree on event id, command id, event kind, target
ref, and projection cursor. Mismatches are invalid records and must fail closed
instead of being projected.

## Projection Rule

Projections are rebuildable read models.

Projection records may be optimized for clients, panels, CLI output, local
queries, or management projection files. They must record enough provenance to
identify their source event cursor or source snapshot.

Projection rebuild must be deterministic for the same event stream and
projection version.

Storage adapters must return event-store records in a stable order or expose
enough ordering data for the projection layer to impose one. The first local
server adapter sorts event-store records by event id until a stronger sequence
field is introduced.

## Replay Rule

Replay is a core behavior, not a debugging trick.

Replay must support:

- rebuilding read models after migration
- reconstructing task/session/timeline state after restart
- reconciling client caches
- diagnosing runtime ingestion failures
- preparing management projection exports

Replay must not re-run external side effects. Side effects are represented by
runtime receipts and progress events, not by replaying process execution,
provider prompts, SCM mutations, or network calls.

## Side Effect Rule

External effects run through effect handlers after command admission.

Initial effect families:

- harness/provider runtime effect
- command execution effect
- SCM/forge effect
- checkpoint/diff effect
- research effect
- steward/native harness effect
- storage/projection effect
- notification effect
- custom

Effect handlers append events and receipts as work progresses. They must not
write projections directly as the durable authority.

## Aggregate And Workflow Rule

Nucleus should avoid one giant global stream as the only mental model.

Initial orchestration scopes:

- project workflow
- task workflow
- agent session workflow
- provider runtime workflow
- SCM/change workflow
- checkpoint workflow
- research workflow
- planning workflow
- memory workflow
- host/client workflow

The exact storage layout may use one log, partitioned logs, or backend-native
streams. The contract requirement is stable identity, sequencing, replay, and
projection behavior.

## Implementation Boundary

The orchestration implementation belongs in the portable Rust engine boundary,
not in Tauri UI code.

`nucleus-server` may expose host APIs and transports for orchestration commands
and projections. It must not be the only place orchestration domain logic can
run, because embedded desktop and remote host forms need the same rules.

## Admission Gate Framework Rule

New admission-only gates implement the shared `AdmissionGate` trait
(`nucleus-server::admission_gate`): declare input, blocker, status, and
no-effects types plus pure `blockers` and `classify` functions in one file.
Do not stamp new per-feature types/blockers/record_builder/diagnostics kits.

No-effects claims use the shared serde-flattened structs in
`nucleus-server::provider_no_effects`; a gate must not declare a private
boolean block for effects it did not run. Diagnostics count statuses through
`count_by_status`, not per-family count helpers.

Existing stamped families migrate opportunistically; wire field names are
preserved via serde flatten during migration.

## Non-Goals

This contract does not yet choose:

- concrete event store schema
- exact stream partitioning
- snapshot cadence
- backend transaction strategy
- serialization format
- network protocol
- retention policy
- migration implementation
