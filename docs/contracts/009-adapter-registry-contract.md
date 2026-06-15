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

- adapter identity
- capability snapshot
- configuration entries
- model routes available to the instance
- runtime ownership record
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

## Current Rust Surface

`nucleus-agent-adapters` now contains the first draft of:

- `AdapterRegistryId`
- `AdapterRegistry`
- `AdapterInstanceRecord`
- `AdapterConfigEntry`
- `AdapterConfigValue`
- `AdapterConfigScope`
- `AdapterRuntimeOwnership`
- `AdapterReadiness`
- `AdapterLifecycleStatus`
- `AdapterHealth`
- `AdapterHealthStatus`

These are descriptive registry and runtime ownership types only. Provider
implementations, process spawning, SDK bridges, ACP clients, CLI/PTY control,
health probes, and secret storage remain out of scope.

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

- Registry persistence shape once storage backend is selected.
- Secret reference format and host credential integration.
- Adapter selection rules when multiple instances support the same harness.
- Health probe cadence and failure semantics.
- How model routes are overridden per project or session.
- How external server health and scoped local server health differ in adapter
  readiness.
- Sidecar protocol shape for Claude Agent SDK.
- Whether Kimi Wire should become a first-class Rust adapter path after ACP.
- Whether Pi SDK sidecar is needed after the first RPC adapter exists.

## Next Task

Draft adapter registry selection and persistence semantics.
