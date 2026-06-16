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

The first-pass projection root is:

```text
nucleus/
```

This is intentionally visible. Project management state is shared project
knowledge, not a hidden tool cache.

First-pass layout:

```text
nucleus/
  project.toml
  repos/
    <repo-membership-id>.toml
  tasks/
    <task-id>.toml
  indexes/
    README.md
  artifacts/
    README.md
```

`nucleus/` is the portable projection. The server may keep richer local state
elsewhere.

Reserved but not first-pass:

- `nucleus/history/`
- `nucleus/decisions/`
- `nucleus/validation/`
- `nucleus/forge/`

Hidden roots such as `.nucleus/` remain a fallback only if a later tooling
constraint proves visible paths are unworkable.

## Projection Record Model

Projection records should be line-diff-friendly and schema-versioned.

Each committed record must include:

- `schema_version`
- stable record id
- project id where applicable
- human-readable title or label where applicable
- record revision or updated timestamp when known

Project metadata record:

- project id
- display name
- status
- importance baseline
- sync policy
- management repo marker
- shared documentation refs

Repo membership record:

- repo membership id
- project id
- display name
- remote refs where available
- default branch where available
- portable role or purpose
- current path hint
- path history
- missing or moved status
- repair notes

Task record:

- task id
- project id
- title
- description
- acceptance criteria
- importance
- action type
- workflow activity state
- assignment intent
- agent-readiness summary
- validation summary refs
- artifact refs
- low-volume task history summaries

Excluded from projection records:

- secrets and provider auth material
- provider-native transcripts unless explicitly imported by policy
- live runtime event streams
- live agent sessions
- terminal and browser state
- local caches and indexes
- machine-specific absolute paths except repairable path hints
- raw validation output unless stored as an artifact reference

## Sync Policy

Initial sync policies:

- manual: prepare changes, human commits and pushes
- assisted: steward prepares commits and asks before push
- automatic: steward may commit and push management-only changes
- reviewed: steward opens PRs for shared management-state changes

Sync policy must be explicit per project or per server profile. Automatic sync
must be scoped to management-state files.

Sync policy grants maximum authority only. Action policy still applies.

Commit and push rules:

- manual policy: steward may prepare changes, but a human creates commits and
  pushes
- assisted policy: steward may prepare management-state commits; commit or push
  requires approval unless project policy grants a narrower exception
- automatic policy: steward may commit and push management-only changes, but
  may not resolve semantic conflicts, delete tasks, rewrite meaningful history,
  change sync policy, or change project identity without approval
- reviewed policy: steward prepares a branch or pull request instead of
  updating the shared branch directly

Automatic sync must stop when the working tree includes code changes unless
the implementation can prove that the commit contains management-state files
only.

## Project Steward Role

The project steward is a bounded Nucleus service role.

It may:

- inspect project and task records
- inspect Git status and sync queues
- validate task schemas
- normalize task metadata
- prepare management-state commits
- reconcile mechanical conflicts
- detect stale, duplicate, blocked, or conflicting task records
- update project docs and indexes
- link tasks to commits, branches, pull requests, issues, and artifacts
- ask for human decisions on semantic conflicts

It may commit or push only when the active sync policy and persona policy both
grant that authority.

It must not silently:

- delete tasks
- rewrite meaningful task history
- resolve semantic conflicts
- push code changes
- change project identity or repo membership
- change sync policy
- expose secret material

It must never:

- use management-sync authority to modify source files
- include secrets or provider auth material in repo-backed management state
- treat model output as approval
- bypass task, SCM, forge, or native persona policy

The steward should run through the native harness runtime contract rather than
as an external bridged provider. Its Git/forge authority is governed by this
sync contract and project policy.

## Conflict Classification

Mechanical conflicts are conflicts where the steward can preserve both sides
without changing task meaning.

Examples:

- reordered task metadata
- formatting-only differences
- concurrent edits to different fields in the same task record
- duplicate generated indexes that can be rebuilt from source records

Semantic conflicts require human approval.

Examples:

- conflicting task status changes
- conflicting acceptance criteria
- assignment or ownership disagreements
- task deletion versus task update
- changed project identity or repo membership
- history rewrite affecting meaning

The steward may prepare a semantic merge proposal, but it must not apply it
without approval.

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

No SCM/forge crate exists yet.

`nucleus-native-harness` now names steward-facing policy vocabulary:

- `NativeSyncAuthority`
- `NativePersonaCapability::CommitManagementState`
- `NativePersonaCapability::PushManagementState`
- `NativePersonaCapability::ProposeSemanticConflictResolution`
- `NativeApprovalPolicy::RequiredBeforeCommit`
- `NativeApprovalPolicy::RequiredBeforePush`
- `NativeApprovalPolicy::RequiredBeforeDelete`
- `NativeApprovalPolicy::RequiredBeforeHistoryRewrite`
- `NativeApprovalPolicy::RequiredBeforePolicyChange`

This is descriptive policy vocabulary only. Git sync implementation remains out
of scope until the projection file model is settled.

## Research Gaps

- Management branch versus main-branch sync.
- Conflict model for simultaneous task edits.
- Forge issue mirroring semantics.
- Webhook versus polling refresh.
- Projection file schema validation and migration policy.

## Next Task

Draft projection storage Rust surface boundaries.
