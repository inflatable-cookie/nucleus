# 011 SCM And Forge Sync Contract

Status: draft
Owner: Tom
Updated: 2026-06-16
Spec refs: `docs/specs/002-git-backed-project-management-state.md`

## Purpose

Define the first boundary for Git, SCM, forge, and project-management sync.

Nucleus should make project management state portable and committable without
turning Git into the live runtime database.

## Authority Boundary

The local Nucleus server owns the active working set.

Repo-backed management files are a shared projection of project intent. They
are portable, reviewable, and syncable, but they are not the only runtime state
store.

Git and forges provide synchronization, review, discovery, and collaboration
signals.

## State Split

Shared committable state may include:

- project metadata
- repo membership declarations
- task records
- acceptance criteria
- workflow-level task status
- assignment intent
- validation summaries
- documentation and decision records
- artifact references
- low-volume task history summaries

Server-local state must include or may include:

- live agent sessions
- runtime event streams
- terminal and browser attachment state
- local adapter runtime state
- local indexes and caches
- personal workspace state
- machine-specific paths unless modeled as repairable project metadata

Provider-owned state must be referenced rather than copied unless an explicit
import policy exists.

## Projection Rule

The repo projection should use small, stable-id records.

One task per file is preferred over one large shared document. Git conflict
handling should happen at task-record level where possible.

The exact path is unsettled. Candidate roots include:

- `nucleus/`
- `.nucleus/`
- `docs/nucleus/`
- `docs/project/`

Visible paths are preferred for reviewability unless tooling constraints prove
otherwise.

## Sync Policy

Initial sync policies:

- manual: prepare changes, human commits and pushes
- assisted: steward prepares commits and asks before push
- automatic: steward may commit and push management-only changes
- reviewed: steward opens PRs for shared management-state changes

Sync policy must be explicit per project or per server profile. Automatic sync
must be scoped to management-state files.

## Project Steward Role

The project steward is a bounded Nucleus service role.

It may:

- normalize task metadata
- prepare management-state commits
- reconcile mechanical conflicts
- detect stale, duplicate, blocked, or conflicting task records
- update project docs and indexes
- link tasks to commits, branches, pull requests, issues, and artifacts
- ask for human decisions on semantic conflicts

It must not silently:

- delete tasks
- rewrite meaningful task history
- resolve semantic conflicts
- push code changes
- expose secret material

The steward should run through the native harness runtime contract rather than
as an external bridged provider. Its Git/forge authority is governed by this
sync contract and project policy.

## Forge Boundary

Forges are adapters over collaboration surfaces.

Initial forge surfaces:

- repository refs
- branches
- commits
- pull requests
- issues
- comments
- webhooks or polling refresh

Forge issues may mirror or link to Nucleus tasks. They must not replace the
Nucleus task identity model unless a later contract explicitly promotes that
mode.

## Current Rust Surface

No Rust surface exists yet.

This contract should eventually inform an SCM/forge crate or module boundary,
but implementation is out of scope until the projection and sync policy settle.

## Research Gaps

- Canonical repo projection path.
- File format for task records and project metadata.
- Management branch versus main-branch sync.
- Conflict model for simultaneous task edits.
- Forge issue mirroring semantics.
- Webhook versus polling refresh.
- Steward-agent authority and approval policy.

## Next Task

Research Nucleus native harness and steward runtime semantics.
