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
- task list
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

These are descriptive domain types only. Storage, path repair, repo scanning,
activity scoring, and task scheduling remain out of scope.

## Control Plane Boundary

Desktop, web, mobile, and CLI clients are clients.

The server API is the durable contract. Tauri must not become the authority for
project, task, workspace, or agent state.

## Next Task

Draft adapter secret reference and credential boundary semantics.
