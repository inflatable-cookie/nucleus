# 008 Storage State Persistence Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the persistence boundary for durable nucleus state.

The server owns durable state. Storage is a server concern, not a desktop
client concern. This contract names what must persist before a backend is
chosen.

Some durable project-management state may also be projected into a Git-backed
management repository for portability and collaboration. That projection is a
sync surface, not a replacement for the active server state store.

Persistent storage must not assume it owns secret material. Durable records may
store secret references and non-secret credential audit records; raw secrets
belong to a future secret store, host credential provider, provider-native auth
state, or external secret manager.

Credential references are durable metadata. Credential material is not durable
Nucleus state unless a later secret-store contract explicitly defines that
storage boundary.

Webhook verification records are sanitized evidence. They may record endpoint
id, provider event ref, verification status, failure kind, and short
non-secret summary. They must not store raw webhook bodies, signature header
values, signing secrets, delivery tokens, cookies, authorization headers, or
full provider request headers.

## Persistence Domains

Initial persisted domains:

- projects
- tasks
- task history
- workspaces
- agent sessions
- model routes
- server config
- event journal

These domains must be recoverable after server restart.

## Record Identity

Persisted records must carry:

- stable record id
- persistence domain
- record kind
- revision id

Domain ids and provider ids are not interchangeable. A persisted record id
identifies nucleus state. Provider-native ids remain attached as metadata on
the domain record that needs them.

## Revision Rule

State changes must be revisioned.

The first model only names revision ids, snapshots, and journal entries. It
does not define conflict resolution, transactions, migration, or replay
semantics yet.

## Projection Validation Rule

Projection validation is an import and sync gate, not a storage engine.

A projected record should be classified as:

- valid
- valid with warnings
- invalid
- unsupported schema

Invalid records must not be silently imported into the active working set.
Unsupported schema records must be preserved and reported. They must not be
ignored, deleted, or rewritten without an explicit migration path.

Validation failures are not Git conflicts by default. Schema errors describe
record shape. Semantic conflicts describe incompatible project or task meaning.
The sync layer may surface both, but it must keep those classes separate.

Validation evidence should be recorded as sanitized state or artifact
references. It must not include secrets, provider auth material, raw provider
transcripts, or high-volume runtime event streams.

## Projection Migration Rule

Projection migrations are explicit policy actions.

Initial migration postures:

- current
- read-only until migrated
- mechanical migration available
- human approval required
- unsupported

Mechanical migrations may add defaulted fields, rename fields, normalize
identifiers, or split records only when meaning is preserved.

Human approval is required when migration changes task meaning, project
identity, repo membership, assignment intent, task history, sync policy, or
artifact references.

Migration tooling must produce a plan before shared projection records are
rewritten. The plan should identify source schema, target schema, affected
records, mechanical actions, and human approval points.

## Journal Rule

The server should preserve enough journal information to support:

- restart recovery
- client reconciliation
- future event replay
- debugging state changes

The event journal is not a UI log. It is state recovery and reconciliation
evidence.

Task history is also not a UI log. It is durable task audit state and should
link to runtime events, artifacts, validation evidence, and session records
rather than copying high-volume streams.

Journal entries must not contain raw secret values, tokens, Authorization
headers, cookie values, or provider-native auth file contents. Credential
events may retain reference ids, source kind, resolution boundary, status, and
sanitized failure reason.

Webhook verification journal entries may retain endpoint id, provider event
ref, verification status, failure kind, and sanitized summary. They must not
retain raw payloads, raw signature material, shared secrets, full headers, or
provider auth material.

## Storage Backend Boundary

Backend selection is deliberately open.

Allowed backend families:

- embedded database
- filesystem
- remote database
- custom

Nucleus must not expose backend-specific assumptions through the public control
plane contract before the storage backend is selected.

Git-backed management files are a projection backend for shared project intent,
not the only storage backend. Server-local storage remains required for active
state, runtime state, indexes, and caches.

## Storage Location

Initial storage locations:

- server data root
- project local path
- remote endpoint
- custom

Project-local storage may be useful for portable project metadata later, but
the server remains the authority for active state.

## Current Rust Surface

`nucleus-core` now contains the first draft of:

- `PersistenceRecordId`
- `PersistenceDomain`
- `PersistenceRecordKind`
- `StorageBackendKind`
- `StorageLocation`
- `PersistenceRecord`
- `RevisionId`
- `StateSnapshot`
- `ChangeJournalEntry`
- `ChangeOperation`
- `ProjectionRoot`
- `ProjectionRecordPath`
- `ProjectionRecordId`
- `ProjectionSchemaVersion`
- `ProjectionRecordRevision`
- `ProjectionRecordKind`
- `ProjectionRecordEnvelope`
- `ProjectionExcludedStateKind`
- `ProjectionValidationStatus`
- `ProjectionValidationReport`
- `ProjectionValidationIssue`
- `ProjectionValidationIssueKind`
- `ProjectionMigrationPosture`
- `ProjectionMigrationPlan`
- `ProjectionMigrationAction`

These are descriptive shared types only. They do not implement a database,
serialization format, migration executor, transactions, replay, file IO, or
sync.

## Research Gaps

- Embedded database choice.
- Serialization format for durable records.
- Migration execution strategy.
- Snapshot and journal replay rules.
- Backup/export/import strategy.
- Whether project-local metadata should mirror any server state.
- Secret-store backend and host credential-provider integration.
- Git-backed management projection format and sync policy.
- Credential rotation and revocation model.
- Webhook replay cache storage model.

## Next Task

Draft SCM/forge conflict and review workflow policy.
