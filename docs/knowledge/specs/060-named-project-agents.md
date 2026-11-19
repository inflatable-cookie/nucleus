# 060 — Named project agents

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-11-11
Decision: Tom, 2026-11-11 — address a project's non-task threads by name, and
never revive an archived one.
Governing refs: [Spec 058](058-responsible-tasks.md) (delegated answers and the
project planner), [service-boundary contract](../contracts/service-boundary.md)
(caller tickets).

**Direction change (Tom, 2026-11-19).** "I want to get more away from the idea of
long-running singleton planner threads - I don't want projects in nucleus to have
\"a planner\", rather just be able to spin up a thread somewhere without ceremony,
plan some stuff, dispatch the workers, and delete the thread when it's done."
Cross-planner messages resolve to the most recently active live (not archived)
thread that works on the project's repositories or has dispatched tasks to it,
from a short-lived cache. If none exists, the sender handles the request itself.
A task's own dispatching planner stays its first route. The registered fallback
planner retires (implementation: nucleus#1373).

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
host, who registered it and when, and issues the thread's participant ticket.
The ticket reaches its thread by the same handover model as every participant
ticket: a self-registering thread takes it in the registration response, a board
registration is handed over on the thread's own next authenticated call, and only
a thread observed live on a host with no calling-thread identity of its own
receives one message. Startup sends nothing, and an unknown delivery is never
replayed.

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

### 3. Responsible threads

Cross-project messages use a short-lived project shortlist from every active
host. A candidate is live and is the project's registered planner, a thread
`agent.register` names, a thread that has dispatched or owns project tasks, or a
thread that works in a project checkout or worktree; a task-role thread is left
out unless it is registered. Nucleus ranks a live registered planner first,
then a thread that dispatched or owns project tasks, then a named agent, then a
thread that only works in the checkout, breaking ties by the most recent host
activity or Nucleus call (Tom, 2026-11-19; nucleus#1379). A design or support
thread merely working in the repository therefore never captures project
messages while a dispatching planner is live. A sender that is itself a
candidate is skipped, so a `tell` from the resolved thread to its own project
reaches the next candidate or records that the sender handles it; it is never
echoed back. A live `project.set-planner` registration ranks first as a
compatibility hint; it
still registers an unknown thread under a free default name and retains its
participant-ticket rules. Clearing the hint leaves the named agent registered.

Nucleus checks liveness before delivery. It clears the affected cache on delivery
failure, host loss or a new dispatching thread. A closed observation discards
the shortlist that contained it and prompts a fresh inventory on the next
lookup. Verified survivors remain available to notice producers during that
refresh.

Each shortlisted thread gets one observation, bounded by
`RESPONSIBLE_OBSERVATION_MS` (5 seconds, sized for a busy Paseo daemon). Only a
positive archived, closed or gone answer drops a candidate. A different-thread
answer makes it `unroutable`, so it is never picked. A read that times out,
fails or cannot confirm the thread (host down, no T3 tombstone) is `unverified`:
it keeps its rank and is picked like a routable one. Delivery then goes through
the ordinary tell path, which queues for a busy recipient and records an unknown
outcome; it is never reported as "handle it yourself". The sender is removed
from the shortlist before the pick, so a `tell` from a thread to its own project
never reaches that thread, whatever the sender's own read says.

When no candidate other than the sender is left, or every candidate is
positively gone, `ask` and `tell` record and return that the sender should
handle the matter; planning questions do not start a decider. Operator-only
matters go to the board. A task's own dispatching planner remains its first
rung. `project.get` and the project settings view show the resolved thread and
the full shortlist, each thread with its host, ranking reasons (registered
planner, dispatcher, named agent, repository worker), last interaction and its
observation (state, detail and when it was taken), plus the cache age. Explicit
named addressing remains independent of this resolver: an unreadable named
agent is still never sent to.

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
default name, hands a self-naming planner its ticket in the assignment response,
rotates the name, keeps a cleared fallback registered, gives a taken default name
a free one, and returns the stored project. `test/registration.test.ts` covers
the self handover, the board handover, unknown delivery and offline hosts.
`test/planner-participant-tickets.test.ts` proves the ticket handover model the
registry reuses. `test/settings-project-editor.test.ts` renders the board list. The resolver,
cache and routing cases are in `test/responsible-thread-resolver.test.ts`,
`test/responsible-thread-cache.test.ts` and `test/responsible-thread-routing.test.ts`.
