# 007 Server Boundary Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the server boundary that all control planes use.

The server is the nucleus authority surface. Desktop, web, mobile, CLI, and
service clients are control planes over the same server-owned state.

## Authority Rule

The server owns:

- project records
- repo membership and path history
- task state
- agent session records
- workspace layouts
- terminal attachment state
- browser attachment state
- harness process lifecycle
- model routes

Clients may cache and render state, but must reconcile with server state.
Tauri must not become the authority for project, task, workspace, or agent
state.

## Deployment Boundary

A deployment has:

- one running server runtime
- one deployment mode
- one or more access endpoints
- one or more clients connected through those endpoints

Initial deployment modes:

- local-only
- local network
- internet reachable
- managed remote

Access transport is not fixed yet. The contract must support local socket,
loopback HTTP, LAN HTTP, remote HTTP, and custom endpoints without treating any
client as the runtime owner.

## Client Boundary

Clients must identify:

- stable client id
- client kind
- display name
- access endpoint
- connection state

Initial client kinds:

- desktop
- web
- mobile
- CLI
- service

## Command Boundary

Clients send commands. The server decides whether to accept, reject, queue, or
execute them.

Initial command categories:

- project commands
- task commands
- workspace commands
- agent session commands
- model route configuration

Commands must carry stable command ids so clients can reconcile retries,
duplicate submissions, and command results.

## Event Boundary

The server emits events for clients to render or reconcile.

Initial event categories:

- project changed
- task changed
- workspace changed
- agent runtime event
- client connected
- client disconnected
- warning
- error

Events must carry stable server event ids. Adapter runtime events retain their
adapter-level event identity inside the server event.

## Current Rust Surface

`nucleus-server` now contains the first draft of:

- `ClientId`
- `ServerCommandId`
- `ServerEventId`
- `ClientIdentity`
- `ClientKind`
- `ClientConnection`
- `DeploymentMode`
- `AccessEndpoint`
- `ServerRuntime`
- `AuthorityArea`
- `ServerAuthority`
- `ServerCommand`
- `ServerCommandKind`
- `ProjectCommand`
- `TaskCommand`
- `WorkspaceCommand`
- `AgentSessionCommand`
- `ServerEvent`
- `ServerEventKind`

These are descriptive boundary types only. Networking, auth, persistence,
subscriptions, runtime routing, and process lifecycle remain out of scope.

## Research Gaps

- Whether the first API should be HTTP/WebSocket, local socket, or both.
- How auth and pairing should work for LAN and internet deployments.
- How event subscriptions and replay should be represented.
- How command acceptance, rejection, queueing, and results should be modeled.
- How server state persists across restarts.

## Next Task

Research Nucleus native harness and steward runtime semantics.
