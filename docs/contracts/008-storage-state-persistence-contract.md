# 008 Storage State Persistence Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-16

## Purpose

Define the persistence boundary for durable nucleus state.

The authoritative engine host owns durable state for the domains assigned to
it. Storage is a host concern, not a UI rendering concern. This contract names
what must persist before a backend is chosen.

Host form does not decide authority by itself. Embedded desktop, local sidecar,
remote authoritative, remote worker, and managed team hosts may all use storage
only for the authority domains assigned by the project authority map.

Some durable project-management state may also be projected into a Git-backed
management repository for portability and collaboration. That projection is a
sync surface, not a replacement for the active authoritative host state store.

Storage backends are adapter-based. An embedded local host or sidecar host may
run as a single-player SQLite-backed executor. A centralized remote team host
may use PostgreSQL or another durable database backend. Domain repositories
must not assume a specific database engine or host form.

Persistent storage must not assume it owns secret material. Durable records may
store secret references and non-secret credential audit records; raw secrets
belong to a future secret store, host credential provider, provider-native auth
state, or external secret manager.

Credential references are durable metadata. Credential material is not durable
Nucleus state unless a later secret-store contract explicitly defines that
storage boundary.

Credential material belongs behind a secret material boundary. Normal durable
server state may retain references, status, scope, backend family, redacted
audit summaries, rotation posture, and revocation posture. It must not retain
raw API keys, access tokens, refresh tokens, pairing secrets, private keys,
webhook signing secrets, provider-native auth files, cookies, authorization
headers, or decrypted secret payloads.

Allowed credential material backend families remain open:

- host credential provider
- OS keychain
- external secret manager
- provider-native auth state
- future Nucleus secret store
- environment variable
- user-interactive resolution
- custom

Credential material classes that need references before implementation:

- client auth credential
- pairing secret
- provider API key
- provider access token
- provider refresh token
- model route credential
- SCM credential
- forge credential
- SSH key
- webhook signing secret
- command secret
- provider-native auth state
- custom

Client auth records are durable metadata. They may store stable client ids,
client kind, display name, auth posture, pairing mode, non-secret credential
references, session refs, revocation state, and sanitized audit summaries.
They must not store credential material, tokens, pairing secrets, private keys,
provider credentials, cookies, or authorization headers in normal server state.

Revocation records are durable audit state. They may close active connections,
interrupt subscriptions, and invalidate replay tokens for the revoked client,
but they must not delete retained events, command evidence, adapter
observations, task history, or audit records.

Credential revocation may invalidate client sessions, adapter instances, model
routes, SCM/forge access, webhook verification, and command execution. It must
be represented as revocation and repair state, not by deleting affected records
or hiding previous evidence.

Credential readiness records may retain preflight status, backend family,
resolution scope, readiness status, repair work refs, and sanitized summaries.
They must not retain raw material or decrypted payloads. Readiness records are
not proof that credential material was resolved; they are only evidence that a
lookup may be attempted, blocked, unsupported, or repair-required.

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
- shared memory records
- planning sessions
- planning artifacts
- task seed records
- deep research runs
- research source records
- research observation records
- research synthesis artifacts
- project tool integration records
- Effigy integration records
- workspaces
- agent sessions
- model routes
- server config
- event journal
- client auth records

These domains must be recoverable after server restart.

## Backend Adapter Rule

The storage backend boundary must separate:

- domain repository traits
- backend adapter selection
- deployment role
- database connection strategy
- transaction support
- migration strategy

Initial backend families:

- SQLite for local single-player development
- PostgreSQL for centralized team-server deployment
- remote SQL or managed database adapters
- in-memory fixtures for conformance tests
- custom backend adapters

SQLite may land first, but it must not become the implicit storage model for
all deployments. Centralized team servers must be able to provide the same
domain repository interfaces through a remote durable backend.

Backend adapters may differ in transaction and migration capability. Those
capabilities should be exposed explicitly instead of hidden behind SQLite-only
assumptions.

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

Conflict and review workflow journal entries may retain server-owned ids,
provider refs, status, resolution policy, merge policy, sanitized summaries,
and approval references. They must not rely on provider pull request ids,
branch names, or issue ids as the durable Nucleus identity.

Abandoned, rejected, resolved, and superseded conflict or review records should
remain auditable until retention policy says otherwise. Cleanup of branches,
worktrees, or provider review objects must not erase server audit records.

Command execution journal entries may retain request id, authority area, scope,
risk, sandbox profile, approval policy, status, exit status, output retention
mode, artifact refs, and sanitized summary.

Command journals must not retain raw stdout, raw stderr, terminal byte streams,
shell traces, environment variables, credentials, tokens, cookies, private
keys, provider auth files, or command helper output by default.

Full command output may be retained only as an artifact reference under an
explicit retention policy. Secret scanning and redaction requirements must be
defined before full command output artifacts become automatic.

Shared memory records may retain accepted summaries, source refs, confidence,
sensitivity, review state, and supersession refs. They must not retain raw
provider transcripts, raw command output, terminal byte streams, secrets,
credential material, or private user notes by default.

Planning records may retain accepted artifacts, task seeds, source refs,
review state, and projection refs. They must not retain private brainstorming,
raw transcripts, unreviewed model output, secrets, or restricted memories by
default.

Deep research records may retain briefs, questions, source metadata,
observations, accepted synthesis, confidence summaries, gap lists, and
projection refs. They must not retain raw browser caches, copyrighted source
payloads, private notes, secret-bearing files, raw transcripts, or unreviewed
model output by default.

Effigy integration records may retain enablement status, manifest path refs,
selector summaries, health summaries, validation plan refs, repair guidance,
and sanitized evidence refs. They must not retain raw command output, secrets,
credentials, local cache paths, release mutation payloads, or CI credentials
by default.

## Runtime Effect Storage Boundary

Runtime effect storage is a server-owned persistence boundary.

It stores enough normalized state for restart recovery, client reconciliation,
and later replay. It is not an event bus, subscription API, scheduler, command
runner, adapter runtime, artifact store implementation, or database choice.

Runtime effect storage domains:

- event records: server event id, ordering token, effect request id, event
  kind, event time, retry linkage, durability posture, and short sanitized
  summary
- command evidence records: command request id, command evidence ref, status,
  terminal state, retry classification, output retention mode, artifact refs,
  and sanitized summary
- adapter observation records: observation batch ref, provider-neutral
  observation refs, task-link proposal refs, conflict or review refs,
  credential-use evidence refs, webhook-verification evidence refs, and
  command-authority request refs
- artifact refs: symbolic refs to separately retained artifacts, with
  retention policy outside event retention
- replay checkpoints: compacted summaries that preserve terminal state, retry
  linkage, unresolved recovery state, and refs that retained events still need

Runtime effect storage must preserve:

- stable event identity and monotonic ordering inside one server runtime
- effect request identity and retry lineage
- latest known non-terminal state until a terminal or recovery state exists
- terminal state and retry classification while the effect remains auditable
- sanitized command evidence refs while retained command events point to them
- adapter observation batch refs while retained adapter events point to them
- artifact refs while artifact retention policy says they are resolvable
- deployment profile used to choose the replay and retention posture

Runtime effect storage must not store by default:

- raw stdout or stderr
- terminal byte streams
- raw provider payloads
- raw webhook payloads
- credentials, tokens, cookies, signing secrets, or provider auth files
- machine-local absolute paths except explicit repairable path hints
- large validation output or command output copied into event records

Symbolic refs remain valid at this boundary. They name the required linkage
without selecting a storage backend or serialization format. A later storage
implementation contract must define how symbolic refs become storage-backed
refs, which records can be garbage-collected, and which query indexes are
required.

Minimum query needs before replay can be implemented:

- list retained events by effect request id
- list retained events after an ordering token for client reconciliation
- resolve retained refs used by a retained event
- find the latest state for an effect request
- find retry successor and predecessor relationships
- find recovery-required effects that need server attention after restart

Compaction is allowed only after the storage layer can prove it will not drop
the last terminal state, unresolved recovery state, retry lineage, retained
sanitized evidence ref, retained observation batch ref, or retained artifact
ref. Compacted summaries must stay sanitized.

The first Rust runtime effect storage boundary types live in `nucleus-server`.
They name retained event records, storage refs, replay checkpoints, latest
state lookups, retry lineage refs, and recovery lookups only. They do not
implement persistence, serialization, migrations, replay, subscriptions, event
transport, artifact storage, or runtime execution.

## Runtime Effect Replay Query Storage Rule

Storage must preserve enough queryable shape for client reconciliation before
live replay is implemented.

Minimum retained query inputs:

- optional client ordering token
- optional effect request ref
- optional retained ref
- optional deployment profile
- optional recovery filter

Minimum retained query outputs:

- ordered retained event records
- compacted replay checkpoints
- latest stored effect state
- retry lineage refs
- recovery-required refs
- missing-ref notices
- expired-ref notices
- partial-result notices

Partial results are valid when retention, compaction, backend limits, or
storage generation boundaries prevent a complete replay. Partial results must
be explicit. They must not be disguised as complete event history.

Storage generation boundaries must be visible to replay queries. If an
ordering token belongs to an expired, compacted, migrated, or unsupported
generation, the server should return a checkpoint, latest-state summary,
or unsupported-generation notice rather than pretending the token is current.

Ref resolution is best-effort inside retention policy. A retained event may
outlive a detailed artifact, evidence record, or observation record if policy
allows a sanitized summary to remain. The query response must distinguish
resolvable refs, expired refs, missing refs, and unsupported refs.

Client caches are not storage. A client may cache replay responses for
responsiveness, but server storage remains the authority for retained effect
state, replay checkpoints, retry lineage, and recovery-required work.

The first Rust replay query types live in `nucleus-server`. They represent
storage generation posture, client ordering tokens, query requests, query
responses, partial-result status, unsupported-query status, and retained-ref
resolution states only. They do not implement storage, replay, migrations,
transport, subscriptions, artifact storage, or client caches.

## Runtime Effect Subscription Storage Rule

Subscriptions may use stored ordering tokens and replay checkpoints for
handshake decisions, but subscriptions are not the storage authority.

Storage may record sanitized subscription evidence later, such as client id,
subscription id, accepted ordering token, disconnect reason, reconnect-required
state, or backpressure summary. That evidence is operational audit state. It
must not replace retained runtime effect events, replay checkpoints, command
evidence, adapter observations, retry lineage, or recovery-required work.

Delivery acknowledgements may be retained as low-value reconciliation evidence
only if they are useful for debugging or flow control. They must not decide
retention, compaction, task state, command state, or adapter state by
themselves.

If a subscription disconnects, storage must still support replay query
reconciliation from the last server-owned ordering token or checkpoint that
retention policy can honor.

The first Rust runtime effect subscription types live in `nucleus-server`.
They represent subscription handshake, lifecycle, acknowledgement posture,
backpressure posture, disconnect reason, and reconnect requirements only. They
do not implement storage, event buses, replay, transport, acknowledgement
processing, client caches, or runtime execution.

## Command Runner Readiness Storage Rule

Command runner readiness records are pre-execution planning evidence.

Storage may retain:

- command request id
- server command id
- readiness status
- runtime surfaces named by the plan
- satisfied gate names
- blocker names
- sandbox profile
- command scope
- output-retention posture
- symbolic artifact refs
- credential-readiness refs
- cancellation and timeout posture
- short sanitized summary

Storage must not retain:

- raw stdout or stderr
- terminal byte streams
- raw environment values
- credential material
- provider-native auth files
- command helper output
- host-specific sandbox internals unless represented as sanitized refs

Readiness records are not command evidence and not artifact storage. A ready
record means the server may queue or hand off execution to a future runner. It
does not prove a process started, output was captured, credentials were
resolved, or evidence was published.

If readiness is blocked by missing credential readiness, missing approval, or
unsupported sandbox profile, the storage record should preserve that blocker
for repair and audit without copying secret material or command output.

## Command Artifact Storage Rule

Command artifact records are metadata and refs, not payloads.

Storage may retain:

- artifact ref
- command request id
- server command id
- payload class
- output retention posture
- approval requirement and approval ref where satisfied
- secret-scan status
- redaction status
- resolution status
- expiry or compaction posture when known
- short sanitized summary

Storage must not retain in normal event, task, command-evidence, or journal
records:

- raw stdout
- raw stderr
- terminal byte streams
- shell traces
- environment values
- credentials, tokens, cookies, private keys, or provider auth files
- unredacted validation output
- artifact payload bytes

Artifact payload storage is a separate implementation boundary. A command
evidence record may point at an artifact ref, but the artifact ref must be
resolved separately and may return resolvable, missing, expired, redacted,
compacted-to-summary, or unsupported.

Full-output artifacts require explicit approval, secret-scan, and redaction
metadata before they can be exposed through replay, client resolution, task
history, or UI rendering. Missing approval, required scan not run, blocked
secret findings, pending redaction, failed redaction, or unsupported scanner
or redactor state must block full-output resolution.

Compaction may preserve sanitized summaries and refs after payload expiry, but
it must not pretend the raw payload remains available.

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
not the only storage backend. Authoritative host-local storage remains required
for active state, runtime state, indexes, and caches.

## Storage Location

Initial storage locations:

- server data root
- project local path
- remote endpoint
- custom

Project-local storage may be useful for portable project metadata later, but
the assigned authoritative engine host remains the authority for active state.

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

`nucleus-server` now contains the first draft of runtime effect storage
boundary vocabulary:

- `RuntimeEffectStorageRecordId`
- `RuntimeEffectReplayCheckpointId`
- `RuntimeEffectStoredEventRecord`
- `RuntimeEffectStoredEventKind`
- `RuntimeEffectStorageRef`
- `RuntimeEffectReplayCheckpoint`
- `RuntimeEffectStoredEffectState`
- `RuntimeEffectStorageQuery`
- `RuntimeEffectLatestStateLookup`
- `RuntimeEffectRetryLineageRef`
- `RuntimeEffectRecoveryLookup`

These are descriptive server-owned runtime storage types only. They do not
select a storage backend, file format, migration model, replay API, event
transport, subscription model, artifact store, scheduler, command runner, or
adapter runtime.

`nucleus-command-policy` now contains the first draft of command runner
readiness vocabulary:

- `CommandRunnerRuntimeSurface`
- `CommandRunnerReadinessGate`
- `CommandRunnerReadinessStatus`
- `CommandRunnerReadinessBlocker`
- `CommandCredentialReadinessRef`
- `CommandEnvironmentPlan`
- `CommandOutputCapturePlan`
- `CommandInterruptionPlan`
- `CommandRunnerReadinessPlan`

`nucleus-server` now contains a server-owned command readiness envelope:

- `ServerCommandRuntimeReadiness`
- `ServerCommandRuntimeReadinessDisposition`

These are descriptive readiness and envelope types only. They do not implement
storage, scheduling, process spawning, sandboxing, credential lookup, output
capture, artifact storage, event publication, or command execution.

`nucleus-command-policy` now contains the first draft of command artifact
metadata vocabulary:

- `CommandArtifactApprovalRequirement`
- `CommandArtifactDescriptor`
- `CommandArtifactPayloadClass`
- `CommandArtifactRedactionStatus`
- `CommandArtifactResolutionStatus`
- `CommandArtifactRetentionPolicy`
- `CommandArtifactSecretScanStatus`

`nucleus-server` now contains server-owned command artifact envelopes:

- `ServerCommandArtifactRecord`
- `ServerCommandArtifactResolution`

These are descriptive artifact metadata and envelope types only. They do not
implement artifact storage, backend selection, scanning, redaction, payload
reads, payload writes, replay exposure, or UI rendering.

`nucleus-command-policy` now contains the first command request and sanitized
evidence storage codec vocabulary:

- `CommandExecutionRequestStorageRecord`
- `CommandEvidenceStorageRecord`
- `CommandStorageAuthorityArea`
- `CommandStorageScope`
- `CommandStorageRisk`
- `CommandStorageSandboxProfile`
- `CommandStorageApprovalPolicy`
- `CommandStorageExecutionStatus`
- `CommandStorageOutputRetention`
- `CommandRecordCodecError`

The codec serializes metadata only. It round-trips command request policy
metadata and sanitized evidence metadata; it does not persist raw stdout,
stderr, terminal streams, shell traces, environment values, credentials, or
process transcripts.

`nucleus-command-policy` also contains structured invocation and process
supervision readiness vocabulary. These are not storage payloads yet. They do
not select a persistence format for invocation attempts, environment policies,
process lifecycle records, or supervision events.

## Command Runner Storage Rule

Command runner state must persist metadata, not raw process streams.

The first local runner storage slice may store:

- command request id
- command evidence id
- command status
- exit status when known
- output retention posture
- stdout artifact ref when retained separately
- stderr artifact ref when retained separately
- sanitized summary
- storage revision

The first local runner storage slice must not store:

- raw stdout bytes
- raw stderr bytes
- terminal byte streams
- shell traces
- environment values
- credential values
- provider-native auth material
- secret file paths
- unredacted filesystem listings beyond the sanitized summary

Command evidence records belong in the command evidence domain. Artifact
payloads, when supported later, belong behind artifact refs and retention
policy. Task history, event journals, projection records, and UI state may link
to evidence refs; they must not copy raw process output by default.

Read-only runner evidence should survive server restart. Retry policy,
subscription fan-out, live output streaming, and artifact payload storage are
separate implementation slices.

## Implementation Gap Classification

The storage contract has enough first-pass record and ref vocabulary to compile
an implementation runway. The remaining decisions should be sequenced by the
first implementation slice.

Foundation blockers before implementation runway:

- choose the first durable storage slice and its acceptance tests
- decide which records must persist in the first slice and which remain
  type-only
- decide whether the first slice includes project-local projection writes or
  only server-local state

First implementation decisions:

- embedded database versus filesystem-backed store for the first local server
- serialization format for durable records
- migration posture for pre-release schema changes
- snapshot and journal replay minimum needed for restart recovery
- storage generation identity for ordering tokens and replay checkpoints
- indexes needed for projects, tasks, adapter registry, sessions, event
  journal, command evidence, and artifact metadata

Subsystem implementation decisions:

- runtime effect replay query implementation
- subscription acknowledgement persistence
- backup, export, and import
- project-local metadata mirroring
- secret-store backend and host credential-provider integration
- credential readiness storage and repair-work projection
- command runner readiness retention and repair-work projection
- Git-backed management projection format and sync policy
- webhook replay cache
- retention policy implementation for abandoned reviews and resolved conflicts
- artifact payload backend and lifecycle
- secret scanner and redactor implementation for command artifacts

Already promoted from earlier research gaps:

- persistence domains and stable record identity
- revision, snapshot, and journal vocabulary
- projection validation and migration posture
- runtime effect storage, replay query, subscription, and transport boundary
  vocabulary
- client auth credential references and revocation record shape
- secret material, rotation, redaction, and revocation vocabulary
- command runner readiness storage rule
- command artifact metadata storage rule
