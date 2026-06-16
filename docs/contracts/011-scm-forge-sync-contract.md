# 011 SCM And Forge Sync Contract

Status: draft
Owner: Tom
Updated: 2026-06-16
Spec refs: `docs/specs/002-git-backed-project-management-state.md`

## Purpose

Define the first boundary for Git, SCM, forge, and project-management sync.

Nucleus should make project management state portable and committable without
turning Git or any other SCM into the live runtime database.

## Authority Boundary

The local Nucleus server owns the active working set.

Repo-backed management files are a shared projection of project intent. They
are portable, reviewable, and syncable, but they are not the only runtime state
store.

SCM systems and forges provide synchronization, review, discovery, and
collaboration signals.

Git is the first practical SCM target. It is not the only model. SCM support
must stay adapter-based so Jujutsu, Mercurial, Pijul, Fossil, or future
systems can be represented without forcing every object into Git's branch and
commit vocabulary.

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

## Projection Validation And Migration

The sync layer must validate projection records before importing them into the
active server working set.

Validation outcomes:

- valid: record can be imported
- valid with warnings: record can be imported, but warnings should be surfaced
- invalid: record must not be imported until repaired
- unsupported schema: record must be preserved and reported, not ignored

Invalid projection records should become repair work, not raw parser failures
in normal UI flows.

Schema errors include missing required fields, invalid ids, unsupported schema
versions, unknown record kinds, invalid references, and excluded state in
projection files.

Semantic conflicts include incompatible task status, acceptance criteria,
assignment intent, task deletion versus update, project identity changes, repo
membership changes, and history rewrites affecting meaning.

Schema validation must not be treated as Git conflict resolution. Git conflict
resolution handles file merge shape. Projection validation handles record
meaning and import safety after a candidate file state exists.

Migration policy:

- old schema records may be read-only until migrated
- unsupported schema records must be preserved
- mechanical migrations may run only when meaning is preserved
- migrations that affect meaning require human approval
- migration plans must be reviewable before shared records are rewritten
- migration evidence should be attached as sanitized validation or artifact
  references

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

Conflict classes must stay explicit.

Initial conflict kinds:

- SCM file merge
- projection schema
- projection semantic
- task semantic
- project identity
- repo membership
- review divergence
- credential or permission
- custom provider value

SCM file conflicts and Nucleus semantic conflicts are different events. A Git
merge conflict can be resolved while the resulting task record is still
semantically unsafe. A clean SCM merge can still create a semantic conflict in
task meaning, project identity, assignment intent, sync policy, or task
history.

Initial conflict statuses:

- detected
- mechanical resolution available
- human approval required
- resolved
- abandoned
- superseded

Initial resolution policies:

- steward may resolve mechanically
- steward may propose
- human approval required
- unsupported

The steward may apply mechanical resolutions only when meaning is preserved.
The steward may propose semantic resolutions, but a human or explicit policy
gate must approve them before shared state is rewritten.

Abandoned and superseded conflicts must retain an audit trail. They must not
be deleted merely because a branch, worktree, review request, or provider-side
object was closed.

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

## SCM And Forge Adapter Boundary

SCM adapters and forge adapters are separate capability surfaces in one
first-pass crate.

SCM adapters cover local and remote source-control state:

- repositories
- worktrees
- remotes
- branches
- commits or provider-neutral changes
- dirty-state observations
- management-state commit preparation
- management-state push capability under policy

Forge adapters cover collaboration state:

- forge repository refs
- pull requests or merge requests
- issues
- comments
- review state
- webhook refresh
- polling refresh

Stable Nucleus ids and provider refs are separate. Provider-native repository,
pull request, issue, comment, branch, and commit refs must be retained as
metadata. They must not replace project ids, repo membership ids, task ids, or
server-owned observation ids.

Provider-neutral change refs must be available for SCM systems where `commit`
is not the right primitive. Initial change kinds include commit, changeset,
patch, revision, checkin, and custom provider-specific values.

Webhook payloads and poll responses are inputs, not durable state. Adapters
must normalize them into server-owned observations before they affect task,
project, sync, or workspace state.

Task links to SCM and forge objects are references. A forge issue may link to a
Nucleus task. It must not become the task identity.

## Credential Boundary

SCM and forge adapters may need credentials. Nucleus records credential
references and sanitized evidence, not credential material.

Initial credential kinds:

- local SCM command credential
- forge API token
- forge app installation
- SSH key
- webhook signing secret
- host credential provider
- external secret manager
- provider-native auth state
- custom provider value

Local SCM command credentials and forge API credentials are separate
boundaries. A local Git, Jujutsu, Mercurial, or future SCM command may use host
credential state without granting Nucleus forge API authority. A forge API
credential may inspect pull requests or issues without granting local command
authority.

Credential references may identify where resolution happens:

- server secret store
- host credential provider
- provider-native auth
- external secret manager
- user interactive flow
- unresolved

Projection records, task history, observations, journals, runtime events, and
logs must not contain raw secrets, tokens, authorization headers, cookies,
private keys, webhook signing secrets, provider-native auth files, or
credential helper output.

Sanitized credential evidence may retain:

- credential reference id
- credential kind
- resolution boundary
- status
- failure kind
- short non-secret summary

Credential failure evidence may become repair work. It must not copy provider
error output unless that output has been sanitized.

SCM and forge adapters must expose whether they can use credential references.
Credential lookup, prompting, storage, rotation, and revocation remain outside
the adapter type surface until a secret-store contract exists.

## Webhook Verification Policy

Webhook ingestion requires verification policy before it can affect Nucleus
state.

Initial verification methods:

- shared secret HMAC
- provider signature
- mutual TLS
- network boundary only
- disabled for local development
- unsupported

Webhook signing secrets are credential references. They are not projection
state and must not be stored in observations, task history, journals, runtime
events, or logs.

Webhook payloads are untrusted inputs until verification succeeds or policy
explicitly marks the local-development path as disabled verification. A
verified webhook may produce normalized forge observations. A rejected webhook
may produce sanitized verification evidence or repair work, but it must not
mutate project, task, sync, or workspace state.

Sanitized webhook verification evidence may retain:

- webhook endpoint id
- provider event ref where safe
- verification status
- failure kind
- short non-secret summary

Verification evidence must not retain raw payload bodies, signature header
values, signing secrets, delivery tokens, cookies, authorization headers, or
full provider request headers.

Adapters should expose whether webhook verification is supported. If a forge
adapter can receive webhooks but cannot verify them, Nucleus must treat the
webhook path as unavailable for trusted state changes.

## Review Workflow Policy

Review workflows are server-owned records that may link to forge pull requests,
merge requests, branch-like refs, and work sessions. A pull request id must not
replace a task id, work-session id, conflict id, or review-workflow id.

Initial review workflow statuses:

- draft
- open
- changes requested
- approved
- ready to merge
- merged
- rejected
- abandoned
- blocked

Initial merge policies:

- direct merge allowed
- review request required
- human approval required
- unsupported

A work session may move to review by opening a review request, attaching an
existing provider review object, or preparing a direct merge proposal. The
review workflow records the server-owned state. Provider refs remain metadata.

Nucleus may merge directly only when project sync policy, SCM capability,
forge capability, work-session state, validation evidence, and approval policy
all allow it. Otherwise it must open or update a review workflow and wait for
human or policy approval.

Rejected or abandoned review work must be retained as audit state. Nucleus may
clean up branches or worktrees only after unmerged work has been retained,
discarded by explicit approval, or linked to a superseding review workflow.

Review workflows may link back to tasks. Those links are evidence and workflow
context. They must not mutate task acceptance criteria, assignment state, or
activity state without a task-domain action.

## Branch And Worktree Session Policy

In-app branch and worktree management is part of the SCM boundary. It is not a
desktop-only convenience.

Nucleus must model bounded SCM work sessions for human and agent work. A work
session groups a task, thread, branch-like ref, worktree-like ref, review
target, and lifecycle state where the provider supports those concepts.

Initial isolation modes:

- primary worktree branch
- per-thread worktree
- external managed
- unsupported

Primary worktree branch mode uses the project checkout as the active work
location and moves it to a temporary branch or provider-equivalent change
surface for a bounded session. This is simpler for testing and local developer
workflow because the known directory remains the directory under test. It
assumes all active threads for that repo share the same active branch context.
Nucleus must surface that shared context clearly before starting agent work.

Primary worktree branch mode must require a clean or explicitly recoverable
worktree before switching, merging, or abandoning the session. It must not hide
thread conflicts caused by multiple agents sharing the same checkout.

Per-thread worktree mode creates or registers a separate worktree, temporary
checkout, or provider-equivalent isolated location for each thread or task
attempt. This supports parallel work, but it may make testing harder when a
project can only run one dev server, database, hardware target, simulator, or
build output location on a machine at once.

Per-thread worktree mode must track runtime constraints separately from SCM
state. Initial constraints are:

- single runnable instance
- shared service conflict
- isolated
- unknown

Work sessions may end by opening a review request, merging into a target ref,
abandoning the attempt, or handing off for manual review. Merge and review
actions are policy-gated. Nucleus must not delete unmerged work silently.

SCM adapters must expose capability flags for starting primary worktree
sessions, starting per-thread worktree sessions, merging work sessions, and
abandoning work sessions.

For non-Git SCMs, `branch`, `worktree`, and `merge` are user-facing concepts,
not mandatory provider primitives. SCM adapters must map work sessions onto the
provider's real isolation and review mechanisms and expose unsupported
capabilities honestly.

## Observation Policy

SCM and forge observations are server-owned facts derived from adapter inputs.
They are not raw Git command output, raw webhook payloads, raw API responses,
or durable task history.

Observation sources:

- SCM inspection
- forge polling
- forge webhook
- manual refresh
- import

Observations may:

- update project activity
- propose task links
- update task-link freshness
- propose low-volume task history summaries
- request human review

Observations must not:

- replace task history
- mutate task state without a task-domain action
- persist raw webhook payloads as task history
- persist raw webhook verification material
- discard provider refs
- copy secret or auth material

Webhook and polling events may duplicate each other. Adapters should attach a
dedupe key when available. De-duplication is a later implementation concern,
but the identity surface must preserve enough provider refs and timestamps to
support it.

## Task Link Policy

Task links connect Nucleus tasks to SCM and forge objects.

Initial link targets:

- branch
- commit
- provider-neutral change
- work session
- conflict
- review workflow
- pull request or merge request
- issue
- comment

Initial link sources:

- user-authored
- adapter-observed
- steward-suggested
- imported

Initial link statuses:

- active
- stale
- missing
- superseded
- unknown

User-authored links are explicit task metadata. Adapter-observed links are
evidence until accepted or promoted. Steward-suggested links require policy
approval before changing projected task state.

Stale links should be retained with status rather than deleted silently.
Missing forge objects should be surfaced as repair work.

## Current Rust Surface

`nucleus-scm-forge` is the type-only crate for SCM and forge adapter
boundaries.

Current modules:

- `ids`: SCM adapter instance ids, forge adapter instance ids, provider refs,
  repository ref ids, worktree ref ids, and work session ids
- `auth`: credential references, credential resolution boundary, credential
  status, and sanitized credential-use evidence
- `webhooks`: webhook endpoint ids, verification policy, verification status,
  and sanitized verification evidence
- `conflicts`: SCM and management-state conflict records, conflict classes,
  statuses, and resolution policies
- `reviews`: review workflow records, review statuses, merge policies, and
  outcomes
- `scm`: SCM provider kind, repository, worktree, branch, commit,
  provider-neutral change, work session, runtime constraint, and remote refs
- `forge`: forge repository, pull request, issue, and comment refs
- `links`: task links to SCM and forge objects
- `observations`: normalized SCM and forge observations, refresh mode,
  dedupe key, and observation effect
- `capabilities`: SCM and forge adapter capabilities

Projection storage vocabulary is split across existing type-only crates:

- `nucleus-core`: projection root, record path, record id, schema version,
  record revision, record kind, record envelope, excluded-state kind,
  validation report, validation issue, migration posture, and migration plan
- `nucleus-projects`: project and repo membership projection records
- `nucleus-tasks`: task projection record and low-volume history summary

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

These are descriptive policy and adapter vocabulary only. Git command
execution, network API clients, webhook endpoints, credential lookup,
credential storage, signature verification execution, sync workers, file IO,
serialization, validation execution, and migration execution remain out of
scope.

## Research Gaps

- Management branch versus main-branch sync.
- Forge issue mirroring semantics.
- Webhook versus polling refresh.
- Direct merge versus review-request default policy.

## Next Task

Draft SCM/forge adapter implementation readiness plan.
