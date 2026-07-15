# 012 Flexible Project Lifecycle And Resources

Status: active
Owner: Tom
Updated: 2026-07-15

## Purpose

Shape one project model that supports disposable chat, durable planning,
folder-backed work, normal repositories, and large multi-repository systems
without forcing repository topology into the basic product workflow.

## Product Position

A project is a Nucleus-owned logical work scope. It is not a repository,
checkout, folder, or management-state file.

A project may own:

- conversations
- goals and tasks
- accepted and proposed memory
- zero or more work resources
- local workspace preferences
- an optional shared project-state projection

The authoritative host state store owns the active project record. Filesystem
and Git resources are optional attachments.

## Capability Progression

Projects gain capabilities as resources are attached. Product creation must
not ask the operator to choose a permanent project type.

Expected progression:

1. a transient chat scope with no resources
2. a named durable project with no resources
3. a project with one or more plain folders
4. a project with one or more Git repositories
5. a project with an optional shared project-state projection

Promotion preserves project, conversation, task, goal, and memory identity.
It does not copy records into a replacement project.

## Project Lifecycle

Initial lifecycle dimensions:

- visibility: active, parked, archived
- retention: transient or durable

Transient projects support disposable chat while retaining the existing
project-scoped conversation boundary. They stay out of the normal named
project rail until promoted, expire under host policy, and may be promoted by
naming or explicitly keeping them.

Creating a task, goal, accepted memory, or attached resource must not leave a
transient project vulnerable to silent expiry. The host must promote it or
require an explicit retention decision before the durable child record is
admitted.

## Resource Model

A project resource is a stable project membership whose current location is a
host-resolved locator rather than identity.

Initial resource kinds:

- `filesystem_folder`
- `git_repository`

Initial portable roles:

- `working`
- `management`
- `reference`

Each resource needs:

- stable resource id and project id
- display name
- resource kind and role
- authoritative host ref
- host-local locator and location health
- path history where applicable
- Git metadata where applicable
- repair diagnostics

Remote topology is represented by host authority plus a host-local locator.
Clients must not assume a path is locally accessible.

## Working Defaults

A project may nominate a default working resource and relative working
directory. These are convenience preferences, not project identity or storage
authority.

Editor, terminal, browser, diff, and agent execution requests must resolve an
explicit resource target or a truthful default. A project with no compatible
resource remains valid; filesystem-dependent actions explain what is missing.

The existing `primary_location` field becomes a derived display hint during
migration and must stop acting as the operational boundary.

## Shared Project Files

The optional management repository remains a portable projection of selected
shared intent. It is not the live project database.

The first product slice supports at most one active management projection. Its
target may be an existing Git resource or a dedicated Git resource attached
with the `management` role.

The product label is **Shared project files**. Configuration stays behind
project management controls and is never required during basic project
creation.

## Minimal Product Workflow

Primary creation actions:

- **New chat**: create and open a transient resource-free project immediately
- **New project**: ask only for a name
- **Open folder or repository**: detect Git and create or attach the matching
  resource

Advanced project controls own:

- resource attachment and removal
- default working resource selection
- shared project files
- parking, archiving, promotion, and deletion

No topology, sync-policy, or management-repository wizard belongs in the
primary path.

## Migration Direction

The current Rust domain and storage surfaces need coordinated migration:

- generalize `RepoMembership` into project resources without losing Git
  metadata or repair history
- persist full resource membership instead of only `repo_count` and
  `primary_location`
- add transient/durable retention state
- represent the optional management projection explicitly
- make project and resource mutations server-owned commands
- update chat and filesystem panels to resolve execution resources separately
  from project identity

Pre-1.0 persisted records may migrate directly to the new schema. Do not keep
parallel repo-only and resource-aware product models.

## Stop Conditions

- project creation requires a local path or Git repository
- transient chat needs a separate conversation ownership model
- Tauri becomes authoritative for project or resource mutation
- an absolute path becomes durable project identity
- management projection is treated as the live state store
- multi-resource selection adds permanent visual complexity to every panel

## Promotion Targets

- `../architecture/project-resource-lifecycle.md`
- `../contracts/003-project-identity-contract.md`
- `../contracts/007-server-boundary-contract.md` when command DTOs settle
- `../contracts/008-storage-state-persistence-contract.md` when retention and
  migration behavior settle
- `../contracts/019-conversation-timeline-contract.md` when transient chat is
  implemented
- `../roadmaps/g04/037-project-resource-foundation.md`
- `../roadmaps/g04/038-project-control-workflow.md`
- `../roadmaps/g04/039-multi-resource-attachment-and-targeting.md`
- `../roadmaps/g04/040-transient-chat-and-promotion.md`
- `../roadmaps/g04/041-shared-project-files-control.md`
