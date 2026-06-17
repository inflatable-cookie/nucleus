# 012 Native Harness Runtime Contract

Status: draft
Owner: Tom
Updated: 2026-06-16
Spec refs: `docs/specs/003-nucleus-native-harness-and-steward-runtime.md`

## Purpose

Define the first boundary for Nucleus-owned harnesses and steward personas.

Native harnesses are app-owned runtimes. They are not external provider
bridges, even when they call local or cloud models internally.

## Harness Families

Nucleus has two harness families:

- bridged harnesses: external provider runtimes reached through adapters
- native harnesses: Nucleus-owned runtimes built for project management,
  stewardship, docs, validation, and sync work

Both families should expose compatible session, event, capability, and audit
concepts where useful. They must not hide their ownership differences.

## Native Runtime Boundary

The native runtime may include:

- deterministic planning and sync tools
- Effigy project workflow tools where enabled
- model backend abstraction
- local model backend
- cloud model backend under policy
- persona capability scopes
- approval gates for privileged actions
- audit records for proposed and completed actions

The native runtime must not pretend to be a provider CLI. It can use the
Nucleus server API and internal domain services directly under explicit
capability policy.

The native runtime should be Rust-owned at the orchestration boundary. Sidecars
or external processes may provide model inference or borrowed runtime behavior,
but Nucleus policies, tools, state access, and audit remain server-owned.

## Initial Personas

Initial native personas:

- project steward
- task triage assistant
- documentation maintainer
- sync conflict assistant
- validation summarizer
- research librarian
- lightweight local helper

The project steward is the first implementation target once the native harness
lane is promoted.

## Steward Authority

The steward has management-state authority only. It may work with project
metadata, task records, documentation indexes, validation summaries, and forge
references. It must not use that authority to mutate source code.

Steward sync authority tiers:

- `none`: no sync action
- `propose-only`: may propose management-state edits
- `prepare-management-capture`: may stage or prepare a capture plan, but not
  create the commit without approval
- `create-management-capture`: may create a management-only commit, snapshot,
  or provider-equivalent local capture under policy
- `share-management-capture`: may push, publish, or provider-equivalent share
  management-state capture under policy

The tier is an upper bound. Per-action approval policy can still require a
human decision.

The steward may run without approval for read-only or deterministic inspection:

- inspect project and task state
- inspect Effigy selector inventory where enabled
- inspect Effigy validation plan shape where enabled
- inspect Git status and sync queue
- validate task schema
- detect stale, duplicate, blocked, or conflicting task records
- detect mechanical conflicts

The steward may prepare or propose:

- task metadata normalization
- management-state commits
- mechanical sync conflict resolutions
- documentation index updates
- task history summaries
- forge links
- validation summaries
- Effigy selector recommendations
- Effigy health and repair summaries

The steward must ask for approval before creating a commit unless project
policy explicitly grants `commit-management-state` authority for the affected
management-state files.

The steward must ask for approval before:

- pushing under assisted policy
- resolving semantic conflicts
- rewriting meaningful task history
- deleting tasks
- changing sync policy
- changing projected project identity or repo membership

The steward must not:

- mutate Effigy manifests without explicit approval
- push code changes under management-sync authority
- modify source files under management-sync authority
- expose secrets
- mutate provider auth state
- bypass task or sync policy
- hide semantic conflicts as mechanical conflicts
- let model backend choice increase authority

The first implemented steward policy records can represent propose-only,
prepare-capture, create-capture, and share-capture tiers. They distinguish
management-state authority from source-code mutation, classify privileged
actions as not required, approval required, allowed by policy, or blocked, and
prove local versus cloud model backend choice does not increase authority.

## First Steward Proposal Records

The first steward proposal records are recommendation-only.

They can represent:

- task metadata normalization
- duplicate task detection
- blocked task flags
- stale task flags
- readiness hints
- documentation index updates
- project-organization hints
- mechanical sync repair
- semantic sync escalation
- management capture preparation
- change-request preparation

Proposal records may target a project, task, task set, docs index, management
projection, projection conflict, SCM work session, change-request prep record,
or custom project surface. They carry proposed field-level changes, review
state, native tool action links, runtime receipt refs, and sanitized evidence
refs.

Evidence sources include Effigy, SCM, projection conflict, SCM work session,
change-request prep, management projection, validation, task, docs, runtime
receipt, and custom refs.

Semantic changes require human approval. A proposal record must not apply a
task mutation, change task activity, change assignment, rewrite acceptance
criteria, or become durable task history by itself.

First sync-assistance records can prepare mechanical conflict repair, semantic
escalation, management capture plans, and change-request preparation. They
must not commit, push, publish, promote, call a forge, or resolve credentials.

## First Steward Command Records

The first steward command records are request and outcome records only.

They can represent:

- read-only inspection
- proposal drafting
- management capture preparation
- sync assistance
- Effigy inspection

Command records are distinct from proposals and mutations. A command request
names persona, command kind, authority scope, target, tool action ref,
evidence refs, and sanitized summary. A command outcome names status,
proposal refs, sync-assistance refs, tool action ref, runtime receipt refs,
evidence refs, and sanitized summary.

Initial command statuses include accepted, rejected, blocked, completed,
completed with warnings, and unknown.

First-pass command records must not execute tools, mutate project state, apply
proposals, commit, push, publish, promote, call a forge, or resolve provider
credentials.

First command admission records map command scope and persona policy to
accepted, requires-approval, rejected, blocked, or unsupported status. Read-only
commands may run without approval. Proposal-only commands require proposal
authority. Capture preparation and sync-sensitive commands require the
matching persona authority and approval state. Unsupported authority
escalation must be rejected before execution.

First command receipt-link records attach runtime receipt refs, tool action
refs, and sanitized evidence refs to steward command outcomes. They must not
copy receipt payloads, command output, model output, terminal streams, provider
payloads, credentials, or secrets.

The first server request-handler boundary can accept native steward command
requests and return accepted, waiting-for-approval, or rejected command
receipts. This boundary performs admission only. It must not run a live steward
loop, execute tools, mutate project state, mutate SCM state, call a forge, or
resolve provider credentials.

## Model Backend Rule

Native harness personas should use deterministic tools before model calls.

Model backends are implementation choices. Initial candidates include local
models through a local inference server, Rust inference libraries, or cloud
model routes under explicit policy.

Small local models are preferred for cheap classification, triage, hygiene,
and summarization when quality is sufficient.

Model backends must be swappable. A persona must declare whether it can run on
local-only models, cloud models, or either. Backend choice must not change the
persona's authority.

The first backend posture records are descriptive only. They can represent
local-only, cloud-only, either, disabled, and unknown deployment posture.
Suitability is recorded separately for deterministic tools, summarization,
classification, and proposal drafting.

Backend descriptors may support later Ollama, llama.cpp, Candle, mistral.rs,
Pi, sidecar, or cloud-route experiments, but this contract does not choose an
inference runtime.

## Session And Event Rule

Native harness sessions are Nucleus-owned sessions.

They should preserve:

- native session id
- persona id
- model backend identity where used
- tool action ids
- approval request ids
- audit event ids

Native runtime events may reuse shared runtime event concepts, but they must be
marked as app-owned. They should not synthesize fake provider ids.

## Tool Action Receipt Linkage

Native tool actions are reference-backed records.

They may retain:

- approval request ids
- runtime receipt refs
- audit event ids
- sanitized evidence refs
- lifecycle state
- sanitized summary

Initial native tool action states include draft, waiting for approval,
accepted, running, completed, completed with warnings, rejected, blocked,
failed, cancelled, and unknown.

Native tool records do not store raw command output, raw model output,
terminal streams, provider payloads, credentials, or secrets. Runtime receipts
remain engine-owned records. Native tool actions link to receipt refs instead
of copying receipt payloads.

## Tool-First Rule

The steward should use deterministic tools before model calls for:

- reading task records
- checking schema validity
- listing Effigy selectors
- inspecting Effigy doctor and test plan output
- listing sync changes
- detecting mechanical file conflicts
- inspecting Git status
- validating indexes

Model calls are for summarization, classification, merge suggestions, and
ambiguous human-facing explanations.

## Effigy Tool Rule

Effigy is an optional project-level tool integration.

When enabled, native personas may use Effigy through server command authority
to inspect task selectors, diagnose project health, plan validation, and
prepare task readiness hints.

Effigy command output should be retained as sanitized evidence or artifact
refs. Raw output, secrets, local cache paths, credentials, and release
mutation evidence must not be copied into task history or memory by default.

The steward may propose Effigy manifest, docs, or task-routing improvements,
but it must not apply them without the same approval and sync policy that
would govern any other project-management file edit.

The first native Effigy records describe integration status, scope, manifest
refs, selector refs, selector kinds, command-scope hints, and sanitized
evidence refs. They support projects without Effigy, root Effigy manifests, and
repo-scoped Effigy selectors. They do not execute Effigy.

The first Effigy health and validation-plan records describe doctor state,
planned validation selectors, repair hints, native tool action links, runtime
receipt refs, and sanitized evidence refs. Validation plans are planning
evidence only unless a separate execution receipt exists.

## Current Rust Surface

`nucleus-native-harness` is the type-only crate for app-owned native harness
boundaries.

Current modules:

- `personas`: `NativePersona`, `NativePersonaId`, `NativePersonaRole`,
  `NativePersonaCapability`, `NativePersonaPolicy`,
  `NativePrivilegedAction`, `NativeActionApproval`, and
  `NativeSyncAuthority`
- `sessions`: `NativeHarnessSession`, `NativeSessionId`, and
  `NativeSessionState`
- `events`: `NativeHarnessEvent`, `NativeEventId`, and `NativeEventKind`
- `tools`: `NativeToolAction`, `NativeToolActionId`,
  `NativeToolActionState`, `NativeToolCapability`, `NativeToolPolicy`,
  `NativeApprovalPolicy`, `NativeApprovalRequest`,
  `NativeApprovalRequestId`, `NativeRuntimeReceiptRef`, and
  `NativeToolEvidenceRef`
- `backends`: `NativeModelBackend`, `NativeModelBackendId`, and
  `NativeModelBackendKind`, `NativeModelBackendDeployment`,
  `NativeModelBackendSuitability`, `NativeModelBackendUse`, and
  `NativeModelBackendStatus`
- `effigy`: `NativeEffigyProjectIntegration`,
  `NativeEffigyIntegrationStatus`, `NativeEffigyScope`,
  `NativeEffigyManifestRef`, `NativeEffigySelectorRecord`,
  `NativeEffigySelectorRef`, `NativeEffigySelectorKind`,
  `NativeEffigyCommandScopeHint`, `NativeEffigyEvidenceRef`,
  `NativeEffigyHealthSummary`, `NativeEffigyHealthStatus`,
  `NativeEffigyValidationPlanSummary`, `NativeEffigyValidationPlanStatus`,
  `NativeEffigyPlannedSelector`, `NativeEffigyValidationPurpose`,
  `NativeEffigyRepairHint`, and `NativeEffigyRepairHintKind`
- `steward`: `NativeStewardProposal`, `NativeStewardProposalId`,
  `NativeStewardProposalTarget`, `NativeStewardProposalKind`,
  `NativeStewardProposalReview`, `NativeStewardProposedChange`,
  `NativeStewardChangeField`, `NativeStewardChangeSemantic`,
  `NativeStewardEvidenceRef`, `NativeStewardEvidenceSource`,
  `NativeStewardSyncAssistance`, `NativeStewardSyncAssistanceId`,
  `NativeStewardSyncAssistanceKind`, `NativeStewardSyncAssistanceLinks`,
  `NativeStewardManagementCapturePlan`,
  `NativeStewardManagementCapturePlanStatus`, and
  `NativeStewardManagementCaptureScope`
- `steward_commands`: `NativeStewardCommandRequest`,
  `NativeStewardCommandOutcome`, `NativeStewardCommandId`,
  `NativeStewardCommandKind`, `NativeStewardCommandScope`,
  `NativeStewardCommandTarget`, `NativeStewardCommandStatus`,
  `NativeStewardCommandAdmission`, and
  `NativeStewardCommandAdmissionStatus`, and
  `NativeStewardCommandReceiptLink`
- `audit`: `NativeAuditEvent`, `NativeAuditEventId`, and
  `NativeAuditEventKind`

This surface is descriptive only. It names the first Rust boundary without
implementing execution, model inference, Git sync, steward behavior, or UI
persona management.

## Research Gaps

- Pure Rust runtime versus sidecar runtime.
- Rig suitability for Nucleus-native agents.
- Candle, llama.cpp, Ollama, and mistral.rs backend tradeoffs.
- Pi as embedded runtime versus bridged external harness.
- Event identity for native harness sessions.
- Persona capability and approval policy model.
- Local model packaging and deployment policy.
- Effigy tool bridge versus harness skill injection.
