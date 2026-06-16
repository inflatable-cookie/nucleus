# 002 Git-Backed Project Management State

Status: active
Owner: Tom
Updated: 2026-06-16

## Purpose

Shape the project-management sync model before storage, task, forge, or
server implementation hardens around the wrong authority boundary.

Nucleus needs task and project management state to be portable, reviewable, and
usable by everyone who clones a project repo. Git is a good collaboration and
durability surface for that shared intent. It is not a low-latency live
database for active server state.

## Working Position

Use a hybrid model:

- local Nucleus server state is the active working set
- repo-backed management files are the portable shared projection
- Git and forges provide synchronization, review, and discovery
- a bounded project steward agent helps keep sync clean
- high-volume runtime state stays out of Git-backed project files

This keeps day-to-day workflow fast while preserving project management state
as committable project knowledge.

## State Classes

### Shared Project Source State

Committable, reviewable, and suitable for clone-based collaboration:

- project metadata
- repo membership declarations
- task records
- task acceptance criteria
- task status at human workflow level
- task assignment intent
- validation summaries
- documentation and decision records
- artifact references
- low-volume task history summaries

### Local Server Runtime State

Server-owned and usually not committed:

- live agent sessions
- runtime event streams
- terminal state
- browser attachment state
- local adapter process state
- local indexes
- caches
- local machine paths unless repairable/portable
- workspace state that is personal rather than project-shared

### Provider-Owned State

Referenced, not copied:

- provider auth
- provider-native session files
- provider transcripts unless imported through explicit policy
- harness caches
- secret material

## Repository Projection

The exact layout is not settled.

Candidate shape:

```text
nucleus/
  project.toml
  tasks/
    open/
    done/
  history/
  artifacts/
```

Open question: whether the directory should be hidden (`.nucleus/`) or visible
(`nucleus/`, `docs/nucleus/`, or `docs/project/`). Visible paths are better for
review and shared project knowledge. Hidden paths are cleaner for tooling but
easier for humans to ignore.

Task files should be small, stable-id records. One task per file is preferred
over one large JSON/TOML document because it gives Git a better merge surface.

## Sync Model

Nucleus should not expose raw Git workflow as the product UX for routine task
collaboration.

Expected flow:

- user edits tasks in a client
- local server updates its active state immediately
- server projects changed shared state into repo files
- sync worker prepares management-state commits
- steward agent handles normalization and mechanical conflict assistance
- Git/forge adapter fetches, rebases, pushes, or opens PRs under policy
- semantic conflicts are surfaced as task-level review, not raw file conflict
  text where possible

## Project Steward Agent

The project steward is a bounded Nucleus role.

Responsibilities:

- normalize task metadata
- detect stale, duplicate, blocked, or conflicting tasks
- prepare management-state commits
- keep local DB and repo projection aligned
- reconcile mechanical Git conflicts
- summarize task history
- link tasks to commits, branches, PRs, issues, and artifacts
- update project docs and indexes
- ask for human decisions on semantic conflicts

Non-goals:

- silently delete tasks
- silently rewrite meaningful task history
- silently resolve semantic disagreements
- run code tasks unless explicitly assigned
- expose or manage raw secrets

## Sync Policies

Initial policy vocabulary:

- manual: prepare changes; human commits and pushes
- assisted: steward prepares commits and asks before push
- automatic: steward may commit and push management-only changes
- reviewed: steward opens PRs for shared management-state changes

Management-state commits should be clearly scoped, for example:

- `nucleus: sync task state`
- `nucleus: update project docs`
- `nucleus: reconcile task history`

## Forge Role

Forges are collaboration adapters, not the source of all project truth.

Possible forge surfaces:

- pull request links
- issue links or mirrors
- webhook-based refresh
- branch and commit references
- comments and review state
- project-board import/export later

Nucleus should not require GitHub or any single forge to make the core model
work.

## Open Questions

- Which repo projection path should be canonical?
- How much task history should be committed by default?
- Should task metadata sync to the main branch, a management branch, or both?
- How should management-state commits relate to code commits?
- What conflict cases can be resolved mechanically?
- What conflict cases require human review?
- How should forge issues mirror task records without replacing them?
- How should multiple local Nucleus servers coordinate when each user has one?

## Promotion Targets

- `docs/architecture/system-architecture.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- new SCM/forge sync contract
- future Rust crate or module for SCM/forge integration

## Next Task

Draft Git-backed project management state semantics.
