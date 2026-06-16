# 003 Project Identity Contract

Status: draft
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the planned durable project model.

Nucleus projects are not filesystem bookmarks. They are durable work records
that may contain one or more repos and survive repo movement.

## Project Fields

Planned fields:

- stable project id
- display name
- status: active, parked, archived
- importance baseline
- repo membership list
- management repository root where configured
- task list
- shared memory refs
- planning artifact refs
- workspace layout references
- activity timestamps

## Repo Membership

Each repo membership record should carry:

- stable repo membership id
- project id
- current path
- path history
- git remote metadata where available
- default branch where available
- missing/moved status
- repair notes

## Management Repository

A project may nominate one repository path as its management repository root.

That root stores portable shared project intent:

- project metadata
- repo membership declarations
- task records
- accepted shared memory records
- accepted planning artifacts
- project documentation
- decision records
- artifact references

The management repository is not the live runtime database. The server imports,
projects, validates, and syncs shared state through it.

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

Repo membership records live under:

```text
nucleus/repos/<repo-membership-id>.toml
```

Repo membership projection records should include:

- schema version
- stable repo membership id
- project id
- display name
- remote refs where available
- default branch where available
- portable role or purpose
- current path hint
- path history
- missing or moved status
- repair notes

Absolute local paths are only hints. They must not be the project identity.
Moved or missing repos should be repairable by updating membership records
without changing project id.

## Project Status

- active: visible in current work surfaces and activity indicators
- parked: hidden from normal focus without being lost
- archived: retained for history and recovery, excluded from active workflows

## Repair Flow

When a repo path is missing, the project must remain intact.

Expected repair actions:

- locate moved repo
- update current path
- keep path history
- mark unresolved membership if not found
- keep tasks and history attached to the project

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

`nucleus-projects` now contains the first draft of:

- `ProjectId`
- `RepoMembershipId`
- `ProjectTaskId`
- `Project`
- `ProjectStatus`
- `ImportanceBaseline`
- `ImportanceLevel`
- `RepoMembership`
- `RepoPathRecord`
- `GitRemoteMetadata`
- `RepoLocationStatus`
- `WorkspaceLayoutRef`
- `ProjectActivity`
- `RepoRepairAction`
- `ProjectProjectionRecord`
- `RepoMembershipProjectionRecord`

These are descriptive domain types only. Storage, path repair, repo scanning,
activity scoring, task scheduling, projection serialization, and projection IO
remain out of scope.

## Control Plane Boundary

Desktop, web, mobile, and CLI clients are clients.

The server API is the durable contract. Tauri must not become the authority for
project, task, workspace, or agent state.
