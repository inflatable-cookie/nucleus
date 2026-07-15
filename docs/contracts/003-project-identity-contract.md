# 003 Project Identity Contract

Status: draft
Owner: Tom
Updated: 2026-07-15

## Purpose

Define the planned durable project model.

Nucleus projects are not filesystem bookmarks. They are logical work scopes
that may contain zero or more filesystem or Git resources and survive resource
movement.

The authoritative host state store owns the active project record. A project
does not require a repository, filesystem folder, or project-owned files.

## Project Fields

Planned fields:

- stable project id
- display name
- status: active, parked, archived
- importance baseline
- retention: transient or durable
- resource membership list
- default working resource where configured
- management projection where configured
- task list
- shared memory refs
- planning artifact refs
- workspace layout references
- activity timestamps
- project authority map refs

## Resource Membership

Each resource membership record should carry:

- stable resource membership id
- project id
- display name
- kind: filesystem folder or Git repository initially
- role: working, management, or reference initially
- authoritative host ref
- current host-local locator
- locator history where applicable
- Git remote and default-branch metadata where available
- missing/moved status
- repair notes

Repository membership is a resource specialization, not the project boundary.
Plain folders are first-class resources and zero-resource projects are valid.

Absolute paths and remote URIs are location hints resolved by the authoritative
host. They are never project or resource identity.

Resource membership mutation uses one host-routed command family with attach,
update, repair, and remove actions. Every mutation carries the expected project
revision, actor, idempotency key, and project-metadata authority host. Attach
and repair inspect locators on that host; clients do not read the path to infer
kind or health. Removing a membership never removes or modifies filesystem
content.

## Retention

Projects may be transient or durable.

A transient project supports disposable conversation without introducing a
second conversation ownership model. It may be omitted from the named project
rail and expired under explicit host retention policy.

Promotion changes the existing project to durable. It must preserve project,
conversation, goal, task, and memory ids. A host must not silently expire a
project after admitting durable child state such as a task, goal, accepted
memory, or attached resource.

## Working Resource

A project may nominate a default working resource and relative directory for
editor, browser, diff, agent execution, and terminal starting-directory
convenience.

The default is not project identity. Filesystem-dependent requests must carry
or resolve a compatible resource target. When no compatible resource exists,
the project remains valid and the action returns a truthful capability error.
An operator terminal is the exception: a resource-free project may start a
shell in the authoritative host user's home directory. This fallback does not
invent a project resource or grant file-backed capabilities to other actions.

The authoritative host resolves working-directory targets in this order:

1. the request's explicit resource membership id
2. the project's configured default working resource and relative directory
3. the sole compatible working resource, when exactly one exists

Zero compatible resources produce capability guidance. Multiple compatible
resources without an explicit or configured target produce an ambiguity error;
the host must not choose by list order. Resolved paths never cross the client
boundary.

Panel target choices are stored as project-id-to-resource-id attribution on the
panel. This keeps a deliberate choice across remount and restart without
turning it into a global project default or leaking it into another project.
Task execution and review snapshots retain the resolved resource id as task
evidence attribution.

## Management Repository

A project may configure one active management projection targeting a Git
resource. The resource may also hold source code or may be a dedicated
management repository.

That projection stores portable shared project intent:

- project metadata
- repo membership declarations
- task records
- accepted shared memory records
- accepted planning artifacts
- project documentation
- decision records
- artifact references

The management projection is not the live runtime database. The authoritative
engine host imports, projects, validates, and syncs shared state through it.
The product presents this optional capability as **Shared project files**.

## Authority Map

Project identity must separate project authority from host connection.

A project may be controlled through multiple hosts, but each durable domain
needs an assigned authoritative engine host before mutation:

- project metadata
- source checkout and worktree state
- tasks
- workspace layout
- sessions
- command execution
- SCM/forge actions
- shared memory
- planning artifacts
- research artifacts
- evidence and audit records

The authority map should survive host movement and support explicit repair
flows when a host is unavailable, renamed, or replaced.

Host connection does not update the authority map by itself. A connected
remote worker can provide execution capacity without gaining source, task, SCM,
or project metadata authority.

## Project Projection Record

The first-pass repo projection root is `nucleus/`.

Project metadata lives at:

```text
nucleus/project.toml
```

The project record should include:

- schema version
- stable project id
- display name
- status
- importance baseline
- sync policy
- management repository marker
- shared documentation refs
- shared memory refs
- planning artifact refs
- updated timestamp or record revision where known

Resource membership records live under:

```text
nucleus/resources/<resource-id>.toml
```

Resource membership projection records should include:

- schema version and stable resource id
- project id
- display name
- kind and portable role
- remote refs where available
- default branch where available
- current locator hint
- locator history
- missing or moved status
- repair notes

Moved or missing resources should be repairable by updating membership records
without changing project id or resource id.

## Project Status

- active: visible in current work surfaces and activity indicators
- parked: hidden from normal focus without being lost
- archived: retained for history and recovery, excluded from active workflows

## Repair Flow

When a resource locator is missing, the project must remain intact.

Expected repair actions:

- locate moved resource
- update current locator
- keep locator history
- mark unresolved membership if not found
- keep tasks and history attached to the project

Selecting a replacement locator preserves resource identity, records locator
history, and fails when the replacement changes the resource kind. A resource
bound to Shared project files cannot be removed until that binding is detached.

## Task Interface

Tasks attached to a project should include:

- stable task id
- project id
- title
- description
- acceptance criteria
- importance
- staleness/neglect score
- action type: research, plan, execute, test, check, review
- assignment state
- activity state
- agent-readiness fields

The dedicated task contract is `005-task-contract.md`.

## Planning And Memory Interface

Projects may link to shared memory and structured planning records.

Project-level memories preserve accepted context such as decisions,
constraints, preferences, risks, and handoff summaries.

Planning records preserve guided project definition such as vision, principles,
architecture outlines, research questions, roadmap outlines, and task seed
groups.

These records belong to their dedicated contracts:

- `013-shared-memory-contract.md`
- `014-structured-project-planning-contract.md`

## Current Rust Surface

`nucleus-projects` now contains the resource-aware project model:

- `ProjectId`
- `ProjectResourceId`
- `ProjectTaskId`
- `Project`
- `ProjectStatus`
- `ProjectRetention`
- `ImportanceBaseline`
- `ImportanceLevel`
- `ProjectResource`
- `ProjectResourceKind`
- `ProjectResourceRole`
- `ResourceLocatorRecord`
- `GitRemoteMetadata`
- `ResourceLocationStatus`
- `WorkingResourceTarget`
- `ManagementProjectionTarget`
- `WorkspaceLayoutRef`
- `ProjectActivity`
- `ResourceRepairAction`
- `ProjectProjectionRecord`
- `ProjectResourceProjectionRecord`

Project storage schema v2 persists resource kind, role, authority host,
locator and history, Git metadata, repair state, retention, working defaults,
and management-projection refs. Schema v3 adds the project-metadata authority
host. Schema-v1 display records and schema-v2 resource records migrate on
decode without changing project id.

Control project records expose sanitized zero-to-many resource summaries with
identity, kind, role, authority host, location health, and default-target
markers. They do not expose host-local locators, locator history, Git remote
URLs, repair notes, relative working directories, or projection policy refs.
Typed resource-mutation candidates require an actor, expected project
revision, supported resource kind, and matching authority host before a later
command executor may act.

The server now owns name-only durable project creation plus typed rename,
park, archive, restore, and delete commands. Lifecycle mutations require an
actor, idempotency key, exact project revision, and matching project-metadata
authority host. Applied commands write durable receipts. Delete is admitted
only when the server can prove that the project has no retained resources,
tasks, conversations, memory, planning, research, or workspace records.

Lifecycle command payloads do not accept filesystem locators, repository
metadata, or topology choices. Project queries exclude lifecycle receipt
records and expose refusal reasons through sanitized command receipts.

## Control Plane Boundary

Desktop, web, mobile, and CLI clients are clients.

The server API is the durable contract. Tauri must not become the authority for
project, task, workspace, or agent state.
