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
- `prepare-management-commit`: may stage or prepare a commit plan, but not
  create the commit without approval
- `commit-management-state`: may create management-only commits under policy
- `push-management-state`: may push management-only commits under policy

The tier is an upper bound. Per-action approval policy can still require a
human decision.

The steward may run without approval for read-only or deterministic inspection:

- inspect project and task state
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

- push code changes under management-sync authority
- modify source files under management-sync authority
- expose secrets
- mutate provider auth state
- bypass task or sync policy
- hide semantic conflicts as mechanical conflicts
- let model backend choice increase authority

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

## Tool-First Rule

The steward should use deterministic tools before model calls for:

- reading task records
- checking schema validity
- listing sync changes
- detecting mechanical file conflicts
- inspecting Git status
- validating indexes

Model calls are for summarization, classification, merge suggestions, and
ambiguous human-facing explanations.

## Current Rust Surface

`nucleus-native-harness` is the type-only crate for app-owned native harness
boundaries.

Current modules:

- `personas`: `NativePersona`, `NativePersonaId`, `NativePersonaRole`,
  `NativePersonaCapability`, `NativePersonaPolicy`, and
  `NativeSyncAuthority`
- `sessions`: `NativeHarnessSession`, `NativeSessionId`, and
  `NativeSessionState`
- `events`: `NativeHarnessEvent`, `NativeEventId`, and `NativeEventKind`
- `tools`: `NativeToolAction`, `NativeToolActionId`,
  `NativeToolCapability`, `NativeToolPolicy`, `NativeApprovalPolicy`,
  `NativeApprovalRequest`, and `NativeApprovalRequestId`
- `backends`: `NativeModelBackend`, `NativeModelBackendId`, and
  `NativeModelBackendKind`
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

## Next Task

Draft SCM/forge conflict and review workflow policy.
