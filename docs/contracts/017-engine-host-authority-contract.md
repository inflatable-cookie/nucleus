# 017 Engine Host Authority Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-17

## Purpose

Define the authority model for Nucleus engine hosts.

Nucleus is engine-first. A server is one host form, not the system core.

## Engine Rule

The portable Rust engine is the core authority implementation surface.

The engine owns domain logic for:

- project records
- task records
- workspace records
- adapter records
- session records
- command policy
- storage and projection records
- runtime scheduling boundaries
- audit and evidence records

The engine may be embedded in a desktop app, wrapped by a local daemon, or
served by a remote daemon. The same domain rules should apply across those
host forms.

## Host Forms

Initial host forms:

- embedded desktop host
- local sidecar host
- remote authoritative host
- remote worker or proxy host
- managed team host
- custom

An embedded desktop host runs the engine in the Tauri app process. It is the
preferred default for single-user local workflows unless the user explicitly
wants always-on handoff, remote clients, or daemon isolation.

A local sidecar host runs the engine in `nucleusd` on the same machine. It is
useful for always-on work, crash isolation, headless use, and multiple local
clients.

A remote authoritative host owns one or more authority domains for a project.
It may own source checkouts, worktrees, sessions, command execution, task
state, workspace state, and runtime processes.

A remote worker or proxy host provides execution, model, harness, browser, or
tool capacity without automatically owning project source or project state.

## Authority Domains

Host connection does not imply project authority.

Authority must be assigned per project and per domain:

- project authority
- source authority
- task authority
- workspace authority
- session authority
- execution authority
- SCM/forge authority
- memory authority
- planning authority
- research authority
- credential authority
- audit/evidence authority
- projection authority

A host may own none, one, or many domains for a project.

A UI may connect to multiple hosts. Those hosts are execution and control
targets until a project authority map grants them domain authority.

## Project Authority Map

Each project needs an authority map before multi-host behavior can be trusted.

The map should record:

- project id
- authority domain
- authoritative host id
- fallback host ids where allowed
- local/remote source location
- allowed mutation scopes
- projection and sync policy
- handoff policy
- conflict policy
- audit evidence refs

The authority map decides where a command, task update, session event, SCM
action, or projection write is allowed to land.

## Local Embedded Mode

For single-user local workflows, embedded desktop mode may own all local
authority domains directly.

This mode should avoid unnecessary process management. It should still use the
same engine contracts as daemon mode so a project can later move to a sidecar
or remote host without changing domain semantics.

The embedded desktop host may expose an optional local control endpoint for
handoff. Exposing that endpoint is a host capability, not proof that a separate
daemon is required.

## Multi-Host Mode

The UI may connect to any number of hosts.

Host connections should expose:

- host id
- display name
- location
- host form
- capabilities
- auth posture
- availability
- assigned authority domains

Multi-host workflows must not assume one global server owns all projects.

Examples:

- local desktop owns project and source authority; remote worker owns execution
  authority for one task
- remote workstation owns project, source, session, and execution authority;
  desktop is a control plane
- project management state is projected into a repo; multiple hosts reconcile
  through SCM/forge policy
- local source stays on the client machine; a remote host proxies model or
  harness access without source authority

## Server Boundary Reinterpretation

`nucleus-server` and `nucleusd` remain useful, but they are host forms over the
engine.

Server APIs are durable contracts for remote, sidecar, and embedded-host IPC
surfaces. They are not proof that every local workflow must run a separate
server process.

When existing contracts say "server owns", read that as "the authoritative
engine host owns" until the wording is migrated.

## Non-Goals

This contract does not implement:

- a host registry
- authority-map persistence
- host-to-host sync
- embedded Tauri engine wiring
- remote auth
- binary transport
- conflict resolution
- process spawning
- migration from current server-named crates

## Immediate Consequence

Runtime work must pause where it assumes a single global server authority.

Next architecture work should:

- update architecture docs from server-first to engine-first
- add host and authority-map vocabulary
- decide which current `nucleus-server` types are host API types
- replan runtime lanes around embedded, sidecar, remote authoritative, and
  remote worker hosts

## Current Rust Surface

`nucleus-server` now contains the first compile-only host authority vocabulary:

- `EngineHostId`
- `EngineHostForm`
- `EngineHostDescriptor`
- `ProjectAuthorityDomain`
- `ProjectAuthorityAssignment`
- `ProjectAuthorityMap`
- `HostAuthorityReadiness`
- `HostAuthorityReadinessStatus`

These types do not implement host discovery, remote transport, auth,
persistence, synchronization, or runtime execution. They exist so later runtime
and storage work can check assigned authority domains instead of assuming one
global server owns every project. Readiness checks distinguish no assignment,
different authoritative host, mutation denied, and ready states.

The client protocol layer now adds client-visible authority-map publication
records:

- project authority-map publication record
- per-domain publication rows
- assigned, mutation-denied, fallback-only, unassigned, and
  publication-deferred states
- validation issues for unassigned domains, deferred publication, and fallback
  duplication

These records are read-model shapes only. They do not grant authority, mutate
authority maps, persist maps, synchronize hosts, authenticate clients, or start
transport behavior.
