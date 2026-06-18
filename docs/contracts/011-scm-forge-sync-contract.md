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
must stay adapter-based so Jujutsu, Mercurial, Pijul, Fossil, Convergence, or
future systems can be represented without forcing every object into Git's
branch and commit vocabulary.

SCM adapters must expose workflow semantics, not just object names. Some
systems treat local capture and shared authority as different operations. In
Convergence, for example, snaps are non-authoritative workspace snapshots while
publication/gate flow is closer to the authoritative review boundary that Git
users often associate with commits or pull requests.

See `docs/research/translation-memos/convergence-scm-shape.md` for the first
Convergence vocabulary pass. That memo is the current guardrail for keeping
core SCM capability names neutral while still allowing Git-specific descriptors
and UI labels.

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

## First Projection Boundary Implementation

The first implementation produces management projection documents and scoped
file writes, not SCM mutations.

It can name first-pass shared file refs, serialize TOML project/task projection
documents, write them under `nucleus/`, and stage projection files for import
validation from authoritative local state. It keeps local UI layout state,
runtime streams, provider auth, terminal/browser attachment state, and raw
validation output out of the files.

SCM adapters remain responsible for status checks, commits, snapshots,
publications, review requests, and provider-specific sync flows. This keeps
the projection boundary usable for Git and non-Git SCMs.

## First Neutral Capability Implementation

The first SCM capability implementation uses provider-neutral capability names
for core driver surfaces:

- inspect working copy
- inspect isolation refs
- inspect captured changes
- prepare management capture
- create management capture
- share management capture
- open review boundary
- start primary working-copy session
- start isolated working-copy session
- integrate work session

Git-like adapters may map these capabilities to branches, worktrees, commits,
pushes, pull requests, and merges. Convergence-like adapters may map them to
snaps, scopes, publications, gates, bundles, promotions, and releases.

The current implementation is metadata only. It does not mutate SCM state.

## Management Capture And Share Authority

Management capture preparation is the neutral boundary between local
management projection apply/review and provider-specific SCM authority.

Core records may say:

- prepare management capture
- capture candidate
- capture evidence
- share readiness
- review boundary readiness
- provider action required

Core records must not treat these as universal terms:

- commit
- branch
- worktree
- push
- pull request
- merge
- snap
- publication
- gate
- promotion

Those terms belong to adapter descriptors, UI labels, provider-specific
command records, or forge-specific workflows.

Git-like adapters may map an accepted management capture to a commit and a
later share step to push or pull-request preparation. Convergence-like adapters
may map local capture to snaps and shared authority to publication or gate
flows. Nucleus core must keep those mappings explicit instead of pretending one
SCM object model is universal.

The first management capture implementation may prepare a request, validate
policy gates, name projection file refs, link apply receipts, and expose review
state. It must not execute provider commands, mutate refs, create snapshots,
publish, push, promote, open review requests, or integrate changes.

## First Driver Registry Implementation

The first SCM/forge registry is a metadata-only descriptor registry.

It can list and resolve SCM and forge drivers separately. Static descriptors
exist for:

- Git SCM semantics
- Convergence SCM semantics
- GitHub forge semantics

Descriptors include provider kind, readiness, implementation status,
capabilities, workflow semantics where applicable, refresh modes where
applicable, and required command scopes.

The registry does not execute provider commands, inspect repositories, call
networks, resolve credentials, mutate files, or own process lifecycle.

## First Git Inspection Implementation

The first Git inspection surface is read-only and record-only.

It accepts Git-specific status snapshots after command evidence has already
been authorized and parsed elsewhere. It projects those snapshots into neutral
SCM working-copy inspection records.

The neutral record can represent:

- branch head
- detached head as a provider-neutral change ref
- unborn or unknown head
- tracked, missing, not-applicable, or unknown upstream state
- clean and code-changed working-copy state
- changed path records
- inspection issues such as detached head and missing upstream

The neutral record does not require every SCM to expose Git commits. Git may
map detached HEAD to a commit-like change ref, but non-Git adapters may leave
head state unknown or map to their own provider-equivalent change surface.

This implementation does not spawn Git, read a repository, inspect the
filesystem, switch refs, stage files, commit, push, publish, resolve
credentials, or mutate the working copy.

## Projection Validation And Migration

The sync layer must validate projection records before importing them into the
active server working set.

The first runtime sync records are provider-neutral plan, repair, assistance,
and capture-preparation records. They can cite projection files, validation
reports, conflict reports, runtime receipts, and steward assistance refs.

They must not silently overwrite task meaning. Invalid or unsupported imports
produce repair proposals. Semantic conflicts require human approval.

Capture preparation is not capture execution. It may prepare a management-state
handoff, but SCM adapters still own commits, snapshots, publications, pushes,
review boundaries, promotions, gates, and provider-specific authority changes.

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

## Projection Apply Boundary

Projection apply is the step after validation and staging. It is not SCM
capture, commit, snapshot, publication, push, promotion, merge, or review
request creation.

The active Nucleus authority host applies staged management projection records
through admitted commands. SCM adapters may provide the candidate file state
and may later share resulting projection changes, but they do not decide active
project/task state by themselves.

Apply policy is provider-neutral:

- Git commits are one possible source or sharing artifact.
- Convergence snaps, publications, gates, and future SCM authority units are
  provider-specific sync artifacts.
- The core apply model talks about staged records, expected revisions,
  conflicts, apply receipts, and review decisions.

No-silent-overwrite rules:

- a staged record with a stale expected revision must not overwrite active
  state
- schema and semantic conflicts must remain distinct
- project identity and repo membership changes require explicit review when
  meaning changes
- task status, acceptance criteria, assignment intent, deletion, and meaningful
  history rewrites require explicit review when conflicting
- unsupported schema records must be preserved and reported
- local-only state must not become shared or active through projection apply

The first implementation may apply only project and task projection records.
Planning artifacts, memories, research synthesis, indexes, artifact indexes,
and custom records remain review-only until their apply policy is promoted.

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

Commit, publish, and push rules:

- manual policy: steward may prepare changes, but a human creates commits and
  pushes, publishes, or provider-equivalent authority transitions
- assisted policy: steward may prepare management-state commits, snapshots, or
  provider-equivalent local capture records; commit, push, publish, or promote
  requires approval unless project policy grants a narrower exception
- automatic policy: steward may create provider-equivalent management-only
  shared records, but may not resolve semantic conflicts, delete tasks,
  rewrite meaningful history, change sync policy, or change project identity
  without approval
- reviewed policy: steward prepares a branch, pull request, publication,
  review workflow, or provider-equivalent gate input instead of updating shared
  authority directly

Automatic sync must stop when the working tree includes code changes unless
the implementation can prove that the provider-equivalent shared record
contains management-state files only.

## Project Steward Role

The project steward is a bounded Nucleus service role.

It may:

- inspect project and task records
- inspect Git status and sync queues
- validate task schemas
- normalize task metadata
- prepare management-state commits, snapshots, publications, or
  provider-equivalent shared records
- reconcile mechanical conflicts
- detect stale, duplicate, blocked, or conflicting task records
- update project docs and indexes
- link tasks to commits, snapshots, publications, branches, pull requests,
  issues, and artifacts
- ask for human decisions on semantic conflicts

It may commit, push, publish, promote, or perform provider-equivalent authority
transitions only when the active sync policy and persona policy both grant that
authority.

It must not silently:

- delete tasks
- rewrite meaningful task history
- resolve semantic conflicts
- push code changes
- publish or promote code changes
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

## First Steward Sync Assistance Implementation

The first steward sync-assistance surface is record-only.

It can represent:

- mechanical conflict repair proposals
- semantic conflict escalation
- management capture preparation
- change-request preparation

Sync-assistance records may link to projection conflict reports, SCM work
sessions, change-request prep records, management projection refs, native tool
actions, runtime receipts, and sanitized evidence refs.

Mechanical repair and semantic escalation must stay separate. Mechanical
repair may describe a safe repair plan. Semantic escalation must require human
approval.

Management capture preparation can describe scope and readiness for a
management-state capture, but it does not create a commit, snapshot,
publication, bundle, promotion, or provider-equivalent authority record.

Change-request preparation can prepare handoff evidence for a later review
boundary, but it does not open a pull request, publish a snapshot, promote a
gate, push to a remote, or call a forge.

Publication requests are outside the first sync-assistance authority. They
must be represented as not-prep-only and require approval or a later contract.

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
- commits or provider-equivalent authoritative records
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
- commits, snapshots, publications, or provider-neutral changes
- dirty-state observations
- management-state capture preparation
- management-state shared-authority capability under policy

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
patch, revision, checkin, snapshot, publication, bundle, release, and custom
provider-specific values.

Initial workflow primitives include commit, changeset, patch, revision,
checkin, snapshot, publication, bundle, release, branch, worktree, gate, and
custom provider-specific values.

Adapters must identify which primitive is local capture, which primitive
creates or updates shared authority, and which primitive acts as the review
boundary. These may be the same in Git-like systems and different in systems
such as Convergence.

Command-backed adapters must declare the command scope they need before
execution. Read-only inspection, management-state capture, source-code writes,
network access, destructive operations, process lifecycle operations, and
secret access are separate command scopes.

Webhook payloads and poll responses are inputs, not durable state. Adapters
must normalize them into server-owned observations before they affect task,
project, sync, or workspace state.

Task links to SCM and forge objects are references. A forge issue may link to a
Nucleus task. It must not become the task identity.

## Provider-Neutral Fixture Policy

SCM and forge implementation must start with provider-neutral fake adapters and
fixtures.

Required first fixture profiles:

- Git-like: commit is both local capture and shared authority, branch is the
  common isolation primitive, pull request is the review boundary.
- Convergence-like: snap is local capture, publication/gate is the review or
  shared-authority boundary, release is a later consumable output.
- Generic forge: pull request, issue, comment, webhook, and polling surfaces
  exist without live provider credentials.
- Credential failure: missing, expired, denied, invalid, and available
  credential references are represented without raw secrets.
- Webhook verification: verified, rejected, replay suspected, unsupported, and
  local-development-skipped paths are represented with sanitized evidence.
- Conflict and review: SCM file conflict, semantic task conflict, direct
  authority update, review request, rejected review, and abandoned work are
  represented without running a real SCM.

Fixture events must cover:

- repository seen
- worktree seen
- branch-like ref seen
- provider-neutral change seen
- workflow semantics declared
- work session changed
- conflict detected
- review workflow changed
- credential use failed
- webhook rejected
- task link proposed

Fake adapters must not require live GitHub, GitLab, Gitea, Bitbucket,
Convergence, Git, Jujutsu, Mercurial, Pijul, Fossil, network, shell, or host
credentials.

Fixture builders are test-support surfaces. They must not be exported as stable
production APIs until a later contract explicitly promotes them. Production
crates may expose descriptive vocabulary needed by both production and tests,
but fake adapter builders should live in dev-only modules, test support crates,
or integration-test fixtures.

## Dev-Only Fixture Boundary

The dev-only fixture boundary is the unpublished
`nucleus-contract-fixtures` crate.

The fixture crate may depend on production type-only crates. Production crates
must not depend on the fixture crate.

Fixture crate rules:

- `publish = false`
- no process spawning
- no network access
- no shell execution
- no live provider credentials
- no host credential lookup
- no raw secrets in fixture data
- no stable production API promises

The fixture crate may contain fake adapter skeletons for SCM and forge contract
tests. These skeletons must return deterministic value records only. They must
not implement production adapter traits, connect to the runtime registry, open
network connections, shell out, or read credentials.

The fixture crate may contain ordered fake scenario scripts. Scenario scripts
are test-support records only. They may prove ordering for SCM observations,
forge observations, task links, and command evidence, but they must not become
the production event model, replay log, or persistence schema.

## Production Adapter Trait Boundary

Production SCM and forge traits are separate surfaces. They may share common
identity, capability, observation, credential evidence, and task-link
vocabulary, but they must not collapse local source-control behavior and forge
collaboration behavior into one catch-all adapter.

Initial SCM trait responsibilities:

- expose adapter identity and provider kind
- expose SCM capabilities
- expose workflow semantics for local capture, shared authority, and review
  boundary
- describe required command scopes before any command-backed operation
- produce normalized SCM observations
- produce provider-neutral repository, worktree, branch-like, and change refs
- surface conflict records and review workflow refs
- report credential-use evidence without credential material

Initial forge trait responsibilities:

- expose adapter identity and provider kind
- expose forge capabilities
- produce normalized forge observations
- surface pull request or merge request refs where supported
- surface issue and comment refs where supported
- verify or reject webhook inputs into sanitized evidence
- surface credential-use evidence without credential material
- link forge objects to server-owned review workflows and task links

Shared observation responsibilities:

- server-owned observation ids
- provider refs retained only as metadata
- dedupe keys for duplicate suppression
- effect hints for downstream policy
- no direct mutation of project, task, or workspace state

Command-backed SCM and forge traits must request command authority through the
server command policy boundary. They must not spawn Git, Convergence, shell, or
forge helper commands directly. Network-backed forge traits must declare
network authority and credential references before execution.

Trait methods may stay synchronous and value-returning for static identity,
capability, workflow semantics, and readiness data. Observation refresh,
webhook processing, command-backed operations, live provider polling, and event
streams are effectful boundaries. They need a later runtime contract before
Rust traits are implemented.

Dev-only fixtures, fake adapters, and scenario scripts are evidence for the
trait boundary. They must not be copied directly into production trait APIs.

First SCM/forge contract tests should prove:

- Git-like workflow semantics: commit as local capture and shared authority,
  branch as isolation, pull request as review boundary
- Convergence-like workflow semantics: snap as local capture,
  publication/gate as shared authority or review boundary
- provider-neutral task links do not replace task ids
- provider refs do not replace Nucleus ids
- fake credential failures produce sanitized evidence
- fake webhook rejection produces sanitized evidence
- fake review workflows retain abandoned work as audit state
- fake conflicts distinguish SCM file conflicts from semantic task conflicts

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

Local SCM commands are server-authorized command requests. SCM adapters must
request command authority through server policy. They must not spawn Git,
Jujutsu, Mercurial, Pijul, Fossil, Convergence, shell, or helper commands
directly.

Credential references may identify where resolution happens:

- server secret store
- host credential provider
- provider-native auth
- external secret manager
- user interactive flow
- unresolved

The server secret material boundary owns credential material class, backend
family, redaction, rotation, revocation, and resolution policy. SCM and forge
adapters may declare and use credential refs through server policy. They must
not implement secret storage or retain raw material.

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
the adapter type surface. The secret material boundary names the policy
vocabulary, but implementation remains deferred.

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

Review workflows are not limited to pull requests. For non-Git SCMs, the
review boundary may be a publication, bundle, gate input, release candidate,
or provider-equivalent shared object.

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

- direct authority update allowed
- review request required
- human approval required
- unsupported

A work session may move to review by opening a review request, attaching an
existing provider review object, publishing to a gate, or preparing a direct
authority update proposal. The review workflow records the server-owned state.
Provider refs remain metadata.

Nucleus may perform a direct merge, publish, promote, or provider-equivalent
authority update only when project sync policy, SCM capability, forge
capability, work-session state, validation evidence, workflow semantics, and
approval policy all allow it. Otherwise it must open or update a review
workflow and wait for human or policy approval.

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

## First Working-Copy Session Implementation

The first working-copy session surface is planning-only.

It can describe:

- primary project checkout sessions
- isolated checkout, worktree, or provider-managed location sessions
- external provider-managed sessions
- unsupported session modes
- base change refs and intended targets where known
- cleanup policy
- user-testability properties
- runtime constraints such as single-runnable-instance and isolated

Primary project checkout sessions record that the known project directory is
the test location and that the checkout is shared. They require clean or
recoverable state before cleanup and retain unmerged work.

Isolated location sessions record that work may happen outside the known
project directory. They retain unmerged work and require human approval before
discarding an isolated location.

Provider-neutral session records may retain branch-like refs, worktree-like
refs, snapshot scopes, or custom provider surfaces. Git-like adapters may map
these records to branches and worktrees. Convergence-like adapters may map
them to snapshot scopes or provider-managed surfaces.

This implementation does not create branches, create worktrees, switch refs,
delete directories, merge, publish, or mutate provider state.

## First SCM Work Item Linkage Implementation

The first SCM work item linkage surface is engine-owned and reference-only.

It links task work items to:

- SCM work session ids
- provider-neutral change refs
- checkpoint ids
- diff summary ids
- runtime receipt ids

The linkage record keeps checkpoints and diff summaries separate from provider
change refs. A Git commit ref, Convergence snapshot ref, publication ref, or
custom provider change ref may be attached as SCM evidence, but it does not
replace Nucleus checkpoint and diff records.

Missing or superseded provider change refs are explicit repair states. They do
not grant publication, merge, review, or task-completion authority.

## First Change Request Prep Implementation

The first change-request prep surface is engine-owned and prep-only.

It can name:

- task id
- task work item id
- SCM work session id
- target shape
- provider-neutral change refs
- checkpoint ids
- diff summary ids
- runtime receipt ids
- review policy
- prep status
- publication state

Initial target shapes include forge review, provider publication, provider
gate, direct authority update, manual handoff, and custom provider value.
GitHub or GitLab pull requests are possible later implementations of forge
review. Convergence-style publication or gate handoffs remain viable without
pretending they are pull requests.

Prep records are distinct from publication records. The first implementation
sets publication to not requested. It does not create pull requests, publish
snapshots, open gates, merge, push, promote, resolve credentials, call remote
APIs, or mutate provider state.

## SCM Diff And Commit Control Surface

Nucleus should provide first-class SCM changes, diff, and commit control
surfaces in the workspace.

The first user-facing shape may resemble familiar Git tooling:

- changed file list
- staged, unstaged, selected, or provider-equivalent change groups
- file and hunk diff review
- discard, stage, unstage, and apply-hunk-style actions where supported
- commit or provider-equivalent local capture action
- push, publish, promote, review-request, or provider-equivalent shared
  authority action where supported
- branch/work session context
- conflict list and repair proposals
- generated commit message proposals
- generated conflict-resolution proposals

These controls are client views over server-owned SCM state. They must request
SCM adapter actions, command authority, credential readiness, and approval
through the server. They must not shell out to Git or mutate files directly
from the client.

Commit controls must not assume every SCM has Git commits. The visible verb may
be commit for Git-like adapters, but the contract is provider-equivalent local
capture and shared-authority transition. The adapter decides whether that maps
to commit, changeset, patch, revision, checkin, snapshot, publication, bundle,
release, branch, worktree, gate, pull request, or direct authority update.

AI-generated commit messages are proposals attached to a work session or
change selection. They should cite the observed change refs and task refs that
informed them. A generated message is not approval to commit, push, publish,
promote, or open a review request.

AI conflict-resolution proposals are reviewable repair plans. Mechanical
conflict repairs may be applied under steward policy. Semantic conflict
repairs require human approval. All applied repairs must retain sanitized audit
evidence.

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
- snapshot
- publication
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
  provider-neutral change, workflow semantics, work session, runtime
  constraint, and remote refs
- `git_inspection`: read-only Git status snapshots and provider-neutral
  working-copy inspection records for head, upstream, dirty state, path
  status, and inspection issues
- `work_sessions`: provider-neutral working-copy session planning records for
  primary checkout, isolated location, external managed, cleanup, testability,
  and runtime constraints
- workspace SCM control surfaces remain in `nucleus-workspaces`; SCM adapters
  provide the underlying observations, work sessions, conflicts, review
  workflows, and command-authority requests
- `forge`: forge repository, pull request, issue, and comment refs
- `links`: task links to SCM and forge objects
- `observations`: normalized SCM and forge observations, refresh mode,
  dedupe key, and observation effect
- `capabilities`: SCM and forge adapter capabilities
- `traits`: static SCM adapter, forge adapter, observation source, and
  readiness trait skeletons
- `effects`: type-only SCM and forge runtime effect request, cancellation,
  retry, observation batch, and outcome vocabulary

Projection storage vocabulary is split across existing type-only crates:

- `nucleus-core`: projection root, record path, record id, schema version,
  record revision, record kind, record envelope, excluded-state kind,
  validation report, validation issue, migration posture, and migration plan
- `nucleus-projects`: project and repo membership projection records
- `nucleus-tasks`: task projection record and low-volume history summary

`nucleus-native-harness` now names steward-facing policy vocabulary:

- `NativeSyncAuthority`
- `NativePersonaCapability::PrepareManagementCapture`
- `NativePersonaCapability::CreateManagementCapture`
- `NativePersonaCapability::ShareManagementCapture`
- `NativePersonaCapability::ProposeSemanticConflictResolution`
- `NativeApprovalPolicy::RequiredBeforeCapture`
- `NativeApprovalPolicy::RequiredBeforeShare`
- `NativeApprovalPolicy::RequiredBeforeDelete`
- `NativeApprovalPolicy::RequiredBeforeHistoryRewrite`
- `NativeApprovalPolicy::RequiredBeforePolicyChange`

These are descriptive policy and adapter vocabulary only. Git command
execution, local SCM command execution, network API clients, webhook endpoints,
credential lookup, credential storage, signature verification execution, sync
workers, file IO, serialization, validation execution, migration execution,
fake adapter implementation, and fixture builder implementation remain out of
scope.

Generic secret material refs now live in `nucleus-server` as compile-only
policy vocabulary. SCM/forge credential refs remain domain-specific records and
must not be treated as raw credential material.

Credential resolution integration maps SCM and forge credential refs to
server-owned credential material refs. A missing, expired, revoked,
permission-denied, requires-user-action, or unsupported credential may block
SCM/forge access, webhook verification, or command execution. The block must
be represented as sanitized credential status and repair work, not raw provider
output.

The first Rust trait skeletons expose static identity, capability, workflow
semantics, readiness, required command scopes, supported refresh modes, and
observation effect support. They do not refresh state, stream events, execute
commands, call networks, verify webhooks, integrate with registries, persist
state, or implement real providers.

Compile-focused trait tests use local test structs only. They prove the static
SCM, forge, and observation-source surfaces can be implemented without dev-only
fixtures, provider behavior, async, streaming, network, command execution, or
registry integration.

## Runtime Effect Boundary

SCM and forge adapters have effectful operations after the static trait
boundary.

Initial SCM effect categories:

- repository refresh
- worktree refresh
- branch-like ref refresh
- provider-neutral change refresh
- dirty-state refresh
- conflict detection
- work-session lifecycle request
- command-backed management-state capture request
- review workflow preparation
- cancellation
- recovery after restart or provider interruption

Initial forge effect categories:

- repository refresh
- pull request / merge request refresh
- issue refresh
- comment refresh
- review workflow refresh
- polling refresh
- webhook input verification
- credential-use check
- review workflow preparation
- cancellation
- recovery after restart or provider interruption

Effectful adapter operations must return normalized observations, provider refs,
sanitized evidence, task-link proposals, conflict records, review-workflow refs,
or command authority requests for server handling. They must not mutate project,
task, workspace, projection, or history state directly.

Command-backed SCM and forge effects must request server command authority.
They must not spawn commands directly. Network-backed forge effects must
declare network authority and credential references before execution.

Cancellation is cooperative at this contract level. An adapter may report that
a provider operation cannot be interrupted safely. The server remains
responsible for recording cancellation requests, timeouts, retries, and final
effect outcomes.

Retries must be server-scheduled. Adapters may classify failures as retryable,
blocked by policy, missing credential, provider rejected, unsupported, timed
out, or unknown, but they must not loop indefinitely inside the adapter.

Async runtime, stream type, polling scheduler, webhook transport, replay store,
and registry integration are unresolved. They require a later runtime contract
before Rust effect traits are implemented.

The first Rust effect type skeletons name adapter effect request ids, SCM/forge
effect request kinds, cancellation posture, retry classification, normalized
SCM and forge observation batches, and effect outcomes. They do not execute,
schedule, poll, stream, persist, retry, cancel, or call providers.

Compile-focused effect type tests use local values only. They prove SCM and
forge effect requests can compose with normalized observation batches,
cancellation posture, retry classification, command-authority-required
outcomes, and request/outcome id linkage without dev-only fixtures or runtime
behavior.

## Runtime Effect Trait Boundary

Runtime effect traits should be split by responsibility.

Initial SCM runtime effect responsibilities:

- accept an SCM effect request
- report whether the request was accepted, rejected, blocked, or unsupported
- return normalized SCM observation batches for refresh-style effects
- return conflict records, task-link proposals, review-workflow refs, or
  provider refs only as normalized outputs
- request server command authority for command-backed SCM work
- report cooperative cancellation, timeout, retry, and recovery outcomes

Initial forge runtime effect responsibilities:

- accept a forge effect request
- report whether the request was accepted, rejected, blocked, or unsupported
- return normalized forge observation batches for refresh, polling, webhook, or
  imported-provider events
- return credential-use evidence and webhook-verification evidence as
  sanitized evidence
- request server command authority for command-backed forge work
- report cooperative cancellation, timeout, retry, and recovery outcomes

Effect acceptance and final outcome reporting may be separate trait surfaces.
Acceptance is a scheduling decision. Outcome reporting is evidence from work
that may complete later, fail, time out, or require recovery. A later Rust
trait draft should not collapse these phases unless the runtime contract proves
that doing so will not hide queued, running, cancelled, timed-out, or recovered
states.

Cancellation needs explicit outcome reporting. A cancellation request is not a
final state. Adapters may report cancelled, timed out, unsupported,
cooperative-only, or recovery-required outcomes after a cancellation request.

SCM and forge runtime traits must not own scheduling, retry loops, timeout
policy, dedupe, persistence, command execution, secret lookup, approval, or
event fan-out. Those are server responsibilities.

The first Rust trait draft may name value-returning acceptance and outcome
surfaces. Async runtime, stream type, polling scheduler, webhook transport,
process supervision, replay store, and registry integration remain deferred.

The first Rust runtime effect trait skeletons now expose separate SCM and forge
request-acceptance and outcome-reporting surfaces. They are value-shaped and
compile-only. They do not schedule work, execute commands, call networks, poll,
stream, persist, retry, cancel, verify webhooks, or mutate Nucleus state.

## Runtime Effect State Machine Policy

Runtime effects move through server-owned state. Adapters report acceptance and
outcomes; they do not own the state machine.

Initial non-terminal states:

- requested
- accepted
- queued
- running
- cancellation requested
- recovery required

Initial terminal states:

- rejected
- blocked by policy
- unsupported
- succeeded
- failed
- cancelled
- timed out

Allowed first transitions:

- requested to accepted
- requested to rejected
- requested to blocked by policy
- requested to unsupported
- accepted to queued
- accepted to running
- queued to running

Allowed completion transitions:

- accepted to succeeded, failed, cancelled, timed out, or recovery required
- queued to cancelled, timed out, or recovery required
- running to succeeded, failed, cancelled, timed out, or recovery required
- recovery required to queued, running, failed, cancelled, timed out, or
  unsupported

Cancellation is a request, not a terminal state. It may move from accepted,
queued, running, or recovery required into cancellation requested. The final
state may still be cancelled, timed out, failed, recovery required, or
unsupported depending on provider behavior.

Retry classification belongs to terminal or recovery-required outcomes. The
server decides whether to retry and creates a new effect request when it does.
Adapters may classify an outcome as retryable, not retryable, blocked by
policy, missing credential, provider rejected, timed out, cancelled,
unsupported, or unknown. They must not loop internally.

SCM and forge effect state should become server events after normalization.
The minimum event vocabulary before implementation is:

- effect requested
- effect accepted
- effect queued
- effect running
- cancellation requested
- effect outcome reported
- effect retry scheduled
- recovery required

Server events may contain effect ids, adapter ids, retry classification,
terminal state, sanitized evidence refs, observation batch refs, and short
summaries. They must not contain raw provider payloads, credentials, raw command
output, or machine-local paths by default.

Minimum adapter effect event payload fields:

- adapter effect request id
- adapter instance id
- adapter surface kind: SCM or forge
- current adapter effect state
- optional terminal adapter effect state
- optional retry classification
- optional observation batch ref
- optional task-link proposal ref
- optional conflict record ref
- optional review-workflow ref
- optional credential-use evidence ref
- optional webhook-verification evidence ref
- optional command-authority request ref

Observation batch refs and sanitized evidence refs may be symbolic before
storage exists. They should name the shape of the reference without committing
to a persistence backend.

Adapter effect events may use the common server event envelope defined in the
server boundary contract. Adapter payloads remain separate from command effect
payloads because provider observations and command evidence carry different
sanitization rules.

Retry-scheduled adapter events must point to the prior effect request id and
the new effect request id. A retry is a new server-scheduled request, not an
adapter-owned loop or mutation of the old outcome.

The first Rust adapter runtime effect event types now name adapter effect event
payloads, adapter effect event kinds, and symbolic refs for observation
batches, task-link proposals, sanitized evidence, and command-authority
requests. They are compile-only. They do not implement event transport,
subscriptions, persistence, replay, scheduling, provider calls, or event
fan-out.

## Adapter Effect Replay And Retention Policy

Adapter effect events follow the server replay and retention policy.

Adapter-specific durable replay events:

- adapter effect requested
- adapter effect accepted
- adapter effect queued
- adapter effect running
- adapter cancellation requested
- adapter effect outcome reported
- adapter effect retry scheduled
- adapter recovery required

Adapter-specific transient reconciliation events:

- repeated polling heartbeat with no observed state change
- duplicate webhook delivery after verification and dedupe
- repeated provider progress summaries
- refresh progress that is superseded by an observation batch

Adapter observation batch refs must remain resolvable while retained adapter
events point to them. Task-link proposal refs, conflict record refs,
review-workflow refs, credential-use evidence refs, webhook-verification
evidence refs, and command-authority request refs must follow the retention
policy of their owning record type once those records exist.

Provider-native refs may be retained as metadata. Raw provider payloads must
not be retained in event replay by default. If a later import policy preserves
raw provider payloads, those payloads must be separate artifacts with explicit
retention and sanitization rules.

Adapter retry linkage must keep the prior terminal adapter effect request id
and the new adapter effect request id resolvable for replay. A retry remains a
new server-scheduled request.

Replay and retention policy types live in the server crate. SCM and forge
adapter crates expose domain refs such as observation batch refs, task-link
proposal refs, sanitized evidence refs, and command-authority request refs.
Those refs remain symbolic until storage and replay contracts exist.

Runtime effect storage keeps adapter event records and retained adapter refs in
server-owned storage. SCM and forge adapters do not own the replay store. They
produce normalized observations, task-link proposals, sanitized evidence, and
command-authority requests that the server may retain by ref. Raw provider
payloads remain outside retained event records unless a later artifact policy
explicitly imports and sanitizes them.

The first Rust runtime effect storage types live in `nucleus-server`. Adapter
refs remain domain-specific values produced by `nucleus-scm-forge` and retained
by server storage records. SCM and forge crates still do not implement storage,
replay, subscriptions, provider calls, command execution, or event fan-out.

The first Rust runtime effect state types now name adapter effect state
records, non-terminal states, terminal states, and optional retry
classification. They are value-shaped only. They do not implement a scheduler,
transition validator, persistence, replay, provider calls, command execution,
or server event fan-out.

## Research Gaps

- Management branch versus main-branch sync.
- Forge issue mirroring semantics.
- Webhook versus polling refresh.
- Direct merge versus review-request default policy.
- Convergence-style publication and gate workflow fixture design.
- First SCM diff/commit control command set and provider-neutral UI wording.
- AI commit-message proposal evidence and approval policy.
- AI conflict-resolution proposal lifecycle and audit policy.
- Mapping SCM adapter operations to command authority scopes.
- Dev-only fixture crate boundary.
- Runtime effect request and outcome type shapes.
- Cancellation and retry policy for long-running provider effects.
- Server event payload shape for effect state changes.
- Runtime effect state transition validation.
- Adapter effect event Rust type boundaries.
- Adapter event transport and subscription policy.
- Adapter replay and retention Rust type boundaries.
- Adapter symbolic ref transition to storage-backed refs.
- Adapter observation replay query and client reconciliation boundaries.
