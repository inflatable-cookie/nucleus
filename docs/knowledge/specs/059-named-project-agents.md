# 059 — Named project agents

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-11-11
Decision: Tom, 2026-11-11 — address a project's non-task threads by name, and
never revive an archived one.
Governing refs: [Spec 058](058-responsible-tasks.md) (delegated answers and the
project planner), [service-boundary contract](../contracts/service-boundary.md)
(caller tickets).

## Problem

A complex project runs several planner-type threads in one orchestration
workspace, each owning a cross-section. A project had one planner thread, and a
message to any other thread named a stored agent ID: an archived thread named
that way was revived instead of refused, and there was no way to ask which
non-task threads a project has.

## Design

### 1. Registry

A project registers named, non-task threads: planners, leads and the
coordinators of a cross-section. `agent.register` takes `{project, name,
purpose}` and registers the calling thread from its Nucleus ticket, or, from the
board, one chosen live thread in `agentId`. Nucleus records the thread, its
host, who registered it and when, and issues the thread's participant ticket
through that host.

A name and a thread are one-to-one within a project: names are unique, and a
thread holds one name. Registering the same thread under a new name renames it;
giving a name to another thread reassigns it. Either way the superseded ticket
stops resolving and the new registration issues a fresh one. Registering the
same thread under the same name only updates the purpose.

`agent.unregister` removes one entry and revokes its ticket. The project's
fallback planner cannot be unregistered while it holds that role: name another
planner with `project.set-planner` first, so the fallback never dangles.

The fallback planner's address belongs to the role. `agent.register` refuses to
give that name to another thread — moving the fallback with `project.set-planner`
moves the name with it — and a fallback registered while another thread already
holds its preferred default name takes a free one (`planner-2`), so a
registration is never silently dropped for another thread's address.

### 2. List

`project.agents` takes `{project}` and returns each entry's name, purpose,
agentId, host, live state, last seen and whether it is the fallback planner.
`project.settings` returns the same list per project, so the board shows it
without a second read.

Live state is `running` (an active turn), `idle` (readable, no turn),
`archived` (the host keeps an archived record), `gone` (the host proves the
thread absent) or `unknown`. A host that cannot be read, or a thread it cannot
describe, is `unknown` and is never read as `gone`. `lastSeen` is the host's
activity stamp for the thread, null when it could not be read. A registered
thread on a host this process is not connected to is `unknown`.

### 3. Project fallback

`project.set-planner` marks a registered agent as the project's fallback
planner — the thread `to: {project}` resolves to. It keeps working for existing
callers: a thread that is not registered yet is registered under the default
name `planner`, and a planner named before the registry existed gains that entry
on the next startup reconciliation. Reassigning the planner moves the name to
the new thread, so the name survives rotation and the old thread stays dead.
Clearing the fallback leaves the thread registered. Any registered agent may be
a task's planner; the submitting thread may be its own.

### 4. Addressing by name

`to: {project, agent: "<name>"}` resolves at send time. Naming an agent is
explicit, so there is no fallback: an archived, gone or unreadable thread fails
with that state and a pointer to `project.agents`, and nothing is sent. Naming
an unregistered name fails as unregistered. Resolution never sends, so a named
thread is never revived.

## Acceptance oracle

`test/project-management.test.ts` registers and lists on a ticket-only host and
on a Paseo host, proves name uniqueness and ticket revocation on rename and
reassignment, resolves a name, the fallback and an archived name (which fails
with no send), and lists every live state. `test/project-planner.test.ts` proves
`project.set-planner` still works, registers an unregistered thread under the
default name, adopts a ticket delivered before the registry existed and rotates
the name. `test/registration.test.ts` covers issuance, unknown delivery, offline
hosts and host-scoped listing; `test/settings-project-editor.test.ts` renders
the board list.
