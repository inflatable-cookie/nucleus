# 014 Swallowtail Application Proof Readiness

Status: promoted and archived
Owner: Tom
Updated: 2026-07-25

## Purpose

Prepare Nucleus to prove Swallowtail through normal native Agent Chat without
touching normal user state or relying on lower-level smoke substitutes.

## Scope

- isolate every desktop-owned persisted path under one explicit Nucleus data
  root
- expose normal Agent Chat cancellation
- preserve cancelled, timed-out, failed, and completed terminal truth
- allow a bounded proof deadline without changing the production default
- launch and inspect the proof profile through Effigy
- stop before authenticated provider calls

## Settled Shape

### Desktop Data Root

`NUCLEUS_DESKTOP_DATA_ROOT` selects the Nucleus-owned root for:

- `state/nucleus.sqlite`
- `state/task-review-snapshots`
- `config/ui.json`

The unset default remains `~/.nucleus`. The override must be an explicit
absolute directory. Invalid configured values fail startup. Nucleus must not
rewrite `HOME`, `CODEX_HOME`, or provider configuration to obtain isolation.

### Agent Chat Cancellation

The product path needs one cancellation action keyed by exact project and
conversation identity. Cancellation targets only the currently active turn.
The request is not itself terminal truth.

The cancellation control must remain reachable while the blocking chat worker
owns its session. It therefore cannot depend on acquiring the serialized chat
service mutex. The Nucleus runtime carries a consumer cancellation signal into
the active Swallowtail turn and requests Swallowtail cancellation there.

### Terminal Truth

The runtime and durable chat record must distinguish:

- completed
- cancelled
- timed out
- failed

A provider cancellation request, deadline expiry, transport failure, and
cleanup failure must not collapse into one string-only failed state.

### Deadline Configuration

The normal Agent Chat turn deadline remains 180 seconds.
`NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS` may select a shorter proof deadline at
process start. Invalid, zero, or longer-than-production values fail startup.
The selected value uses the same Swallowtail deadline mechanism as production;
it is not a simulated timeout.

### Proof Surface

An Effigy selector launches the native desktop with an explicit isolated data
root and optional bounded proof deadline. Evidence extraction reads sanitized
Nucleus records after the app closes.

Stable proof evidence may contain:

- generated scenario and local correlation ids
- exact application, Swallowtail, Codex, model, and compatibility observations
- expected and observed terminal class
- callback and lifecycle counts
- elapsed time, usage/rate summaries when available, and cleanup status

It must not retain credentials, prompts, assistant output, raw provider
payloads or streams, absolute user paths, or raw provider thread/turn ids.

## Non-Goals

- no live Codex call in the readiness implementation
- no workspace, task, SCM, forge, or provider-account mutation
- no proof-only modal or permanent diagnostics panel
- no Swallowtail ownership of Nucleus state, UI, policy, or evidence
- no general replacement for Nucleus configuration

## Acceptance

- default desktop paths remain unchanged
- the explicit data root isolates database, snapshots, and UI configuration
- normal Agent Chat cancellation reaches the active Swallowtail turn
- durable terminal state distinguishes cancellation and deadline
- deterministic tests prove configuration, cancellation, persistence, cleanup,
  and redaction before the live pilot
- the existing sidebar work remains untouched

## Promotion

Durable outcomes moved to:

- `docs/architecture/system-inventory.md`
- `docs/architecture/product-workflow-ui-architecture.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `docs/roadmaps/g05/003-swallowtail-application-proof-readiness.md`
