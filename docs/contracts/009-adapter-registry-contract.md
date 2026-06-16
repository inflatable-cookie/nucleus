# 009 Adapter Registry Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the registry boundary for configured harness adapter instances.

The harness adapter contract defines what an adapter must expose. The registry
defines how configured adapter instances are recorded, inspected, and selected
by the server.

## Registry Identity

Each registry must expose:

- stable registry id
- configured adapter instance records

One server may start with one registry. Multiple registries remain possible for
future profile, tenant, or remote deployment needs.

## Adapter Instance Record

Each configured adapter instance record must expose:

- stable adapter instance id
- adapter identity
- capability snapshot
- configuration entries
- model routes available to the instance
- runtime ownership record
- probe policy
- readiness state
- lifecycle status
- health snapshot

Adapter instance id remains the durable routing key for configured accounts or
runtimes. Driver kind alone is not enough.

## Configuration Rule

Registry configuration must not store secret values directly.

Config values may include:

- strings
- booleans
- integers
- paths
- secret references

Secret references point to a future secret store or host credential provider.

## Credential Boundary Rule

Registry records may store secret references. They must never store secret
values.

Secret references may identify:

- host credential provider entries
- future nucleus secret-store entries
- provider-native auth state
- environment variable names
- external secret-manager entries

Secret references must carry purpose and scope. Initial purposes include API
key, access token, refresh token, external server credential, local CLI auth
state, SDK sidecar credential, MCP server credential, and custom provider
credential.

Provider-native auth state must not be copied into nucleus storage. For local
CLI harnesses, registry records may point at the provider-native auth state or
configuration location, but the credential remains owned by the provider tool
or host credential system.

Secret material may only be resolved inside the server runtime boundary that
needs it. Allowed resolution boundaries are:

- server only
- owned process environment
- owned process stdin
- SDK sidecar
- external server request
- host credential provider only

Remote control planes must not request or receive raw secret material.

Raw secret exposure policy must be explicit. Initial values are never expose,
runtime boundary only, and provider-native auth only.

Credential audit records may retain reference id, source kind, resolution
boundary, status, and failure reason. They must not retain raw secret values,
tokens, keys, Authorization headers, cookie values, or provider-native auth
file contents.

## Scope Rule

Configuration entries may apply at:

- driver scope
- instance scope
- project scope
- session scope

Scope must be explicit so a project-specific model or binary path does not
silently mutate global adapter behavior.

## Server Ownership Rule

Adapter instances that can connect to an external server or spawn a local
server must record ownership mode explicitly.

Initial values:

- external server
- nucleus-owned scoped local server
- unavailable/unknown

For OpenCode, `serverUrl` means external server ownership. No `serverUrl` means
the adapter may spawn `opencode serve` and owns that child process lifecycle.

External server credentials must be secret references. They must not be stored
as plain config values.

SDK sidecar and CLI-backed adapter instances must also record ownership mode.

For Claude, the initial instance record must distinguish:

- nucleus-owned SDK sidecar
- nucleus-owned structured CLI process
- nucleus-owned PTY process
- unavailable/unknown

Claude records must include binary path, sidecar package/version where used,
home/config path, working directory, setting sources, environment refs, launch
arguments, permission mode, model/effort settings, additional directories, and
MCP configuration references.

For Kimi, the initial instance record must distinguish:

- nucleus-owned ACP stdio process
- nucleus-owned Wire stdio process
- SDK sidecar process
- PTY process
- unavailable/unknown

Kimi records must include executable path, `KIMI_CODE_HOME` or equivalent home
path when set, config file path or inline config reference, work directory,
environment refs, model, thinking mode, permission mode, plan mode, MCP config
references, and whether the configured runtime is Kimi Code or legacy Kimi
CLI.

For Pi, the initial instance record must distinguish:

- nucleus-owned RPC stdio process
- SDK sidecar process
- PTY process
- unavailable/unknown

Pi records must include executable path, session directory, working directory,
environment refs, provider, model, thinking level, session name, no-session
mode, default project trust mode, extension/resource loading policy, command
discovery snapshot, sandbox wrapper mode, and whether session-file paths are
recorded directly or through storage references.

## Readiness And Status

Readiness answers whether an adapter can receive work.

Lifecycle status answers where the adapter instance sits in runtime management.

Health is a point-in-time probe result. It must not be treated as a permanent
capability.

## Health And Readiness Probe Rule

Probe policy is durable registry intent. Probe evidence is runtime observation.

An adapter instance may require probes for:

- external server reachability
- owned process liveness
- SDK sidecar handshake
- ACP stdio handshake
- Wire stdio handshake
- RPC stdio handshake
- PTY launch smoke test
- authentication preflight
- version discovery
- model route availability
- capability refresh

Probe targets must match runtime ownership. External server probes check
reachability and authentication; they must not imply nucleus can restart the
server. Nucleus-owned local server, stdio, and PTY probes may check child
process liveness and launch behavior. SDK sidecar probes check the sidecar
boundary, not the provider service directly unless the sidecar exposes that
preflight.

Readiness for new work must be gated by fresh enough required probes. Restored
health and readiness after server restart are stale display state until
required probes run again.

Terminal fallback must be explicit. A passing PTY probe may allow terminal
fallback work only when the adapter instance declares that fallback; it must not
hide failure of a structured transport.

Probe cadence may be:

- on server startup
- before assignment
- periodic
- on runtime transition
- manual only

Failure policy must say whether a failed probe marks the instance unavailable,
degraded, needing configuration, needing authentication, unsupported on the
host, or unknown. The policy may retain stale display state for audit, but that
state cannot authorize new work.

## Selection Rule

Adapter selection must resolve a configured adapter instance, not only a
provider driver kind.

Selection inputs may include:

- explicit adapter instance id
- project reference
- task reference
- session reference
- requested model route
- task model preferences
- required capabilities
- config scope precedence

Selection precedence starts with explicit user choice. Project defaults,
session overrides, model-route matches, capability matches, readiness, and
health may narrow the result. They must not replace the durable adapter
instance id.

Model route selection is not adapter identity. A model route may describe the
model, endpoint, account source, policy, or compatibility family for a
configured instance. The selected adapter instance remains the routing target.

Scoped route overrides may narrow selection. They must not replace the adapter
instance id or mutate adapter instance defaults. A session route override may
change runtime config only when the selected harness supports in-session model
or route changes.

Selection explanations should preserve the reason an instance was chosen. This
is required for project debugging, task audit trails, and later UI review.

## Config Resolution Rule

Config resolution must preserve scope.

Initial scope precedence is:

- driver
- instance
- project
- session

Later scopes may override earlier scopes only for the selected adapter
instance. A session override must not mutate project, instance, or driver
defaults.

Resolved config may expose value kind, key, and scope. It must not expose secret
material. Secret values remain behind secret references until the runtime
boundary needs them.

## Persistence Rule

The registry must persist enough state to recover configured adapter instances
after a server restart without re-discovering user intent.

Persisted registry state must include:

- registry id
- adapter instance id
- adapter identity
- non-secret config entries
- secret references
- model routes
- runtime ownership
- probe policy
- lifecycle status when it represents user intent

Recomputed state must include:

- capability snapshots
- readiness
- health snapshots
- probe evidence
- credential resolution records
- upstream version discovery
- authentication preflight

Health and readiness may be restored as stale display state, but they must be
probed before they are trusted for new work.

The final storage backend is not selected yet. Valid placeholder backend
families are server state store, project-scoped state store, and external
profile store.

Missing configured instances are repair cases. They must be marked unavailable
or require user repair; they must not be silently dropped unless explicitly
removed.

## Current Rust Surface

`nucleus-agent-adapters` now contains the first draft of:

- `AdapterRegistryId`
- `AdapterRegistry`
- `AdapterInstanceId`
- `AdapterInstanceRecord`
- `AdapterConfigEntry`
- `AdapterConfigValue`
- `AdapterConfigScope`
- `AdapterSecretRef`
- `AdapterSecretSource`
- `AdapterSecretPurpose`
- `AdapterSecretScope`
- `AdapterSecretResolutionPolicy`
- `AdapterSecretResolutionBoundary`
- `RawSecretExposurePolicy`
- `AdapterCredentialAuditPolicy`
- `AdapterCredentialResolutionRecord`
- `AdapterCredentialResolutionStatus`
- `AdapterRuntimeOwnership`
- `AdapterSelectionRequest`
- `AdapterSelectionOutcome`
- `AdapterSelectionScope`
- `AdapterCapabilityRequirement`
- `AdapterCapabilityKey`
- `ResolvedAdapterConfigRef`
- `ResolvedAdapterConfigValueKind`
- `AdapterSelectionReason`
- `AdapterRegistrySnapshot`
- `AdapterRegistryPersistedField`
- `AdapterRegistryRecomputedField`
- `AdapterRegistryPersistencePolicy`
- `AdapterRegistryPersistenceBackend`
- `AdapterRegistryRepairPolicy`
- `AdapterProbePolicy`
- `AdapterProbeRequirement`
- `AdapterProbeKind`
- `AdapterProbeTarget`
- `AdapterProbeCadence`
- `AdapterProbeFailurePolicy`
- `AdapterReadinessGate`
- `AdapterStaleStatePolicy`
- `AdapterStateAuthority`
- `AdapterProbeEvidence`
- `AdapterProbeResult`
- `AdapterProbeAssessment`
- `AdapterReadiness`
- `AdapterLifecycleStatus`
- `AdapterHealth`
- `AdapterHealthStatus`

These are descriptive registry, credential, runtime ownership, selection,
persistence, and probe boundary types only. Provider implementations, process
spawning, SDK bridges, ACP clients, CLI/PTY control, active health probes,
selection algorithms, storage engines, secret storage, and credential
resolution remain out of scope.

## Runtime Ownership Rule

Each adapter instance record must store runtime ownership metadata separately
from adapter identity.

Registry records must preserve:

- ownership mode
- process owner
- endpoint label where useful
- command stream semantics
- event stream semantics
- recovery policy

This is required so two instances of the same driver can differ by external
server URL, sidecar boundary, owned stdio process, PTY fallback, or recovery
behavior.

## Research Gaps

- Sidecar protocol shape for Claude Agent SDK.
- Whether Kimi Wire should become a first-class Rust adapter path after ACP.
- Whether Pi SDK sidecar is needed after the first RPC adapter exists.

## Next Task

Draft management projection file model.
