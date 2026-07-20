# 030 Swallowtail Agent Runtime Integration Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-07-20

## Purpose

Make Swallowtail the owner of reusable AI harness communication while Nucleus
retains product intent, authority, tools, persistence, and UI behavior.

## Core Rule

Nucleus talks to harnesses and direct model routes through Swallowtail-backed
adapter implementations. Swallowtail owns provider discovery, protocol
translation, process or transport lifecycle, normalized events, callbacks,
cancellation, timeout, and cleanup.

Nucleus continues to own:

- conversations, turns, tasks, Goals, memory, projects, and resources
- model selection policy and future provider configuration UX
- developer instructions and tool declarations
- tool execution, authorization, receipts, and product consequences
- durable provider references, sanitized history, and UI DTOs
- execution-host selection and resource authority

No Swallowtail crate may depend on a Nucleus crate or persist Nucleus records.

## First Adoption Slice

The first slice replaces the `codex-app-server` implementation behind the
existing `AgentSessionRuntime` and `AgentLiveSession` facade. The registry id,
server chat service, Tauri commands, TypeScript DTOs, prompts, and two Nucleus
tool portals remain unchanged.

The development workspace may use sibling path dependencies. Version or
revision pinning begins when Swallowtail and its consumers enter versioned
distribution; it is not a local-development gate.

## Host And Resource Authority

The Nucleus server resolves the working resource before the adapter runs. The
integration converts that approved location into an opaque Swallowtail
`WorkingResourceRef` and supplies a host-owned local process service.

The initial adapter is embedded-host only. A remote-authoritative resource must
not be executed locally merely because the desktop can see its locator. Remote
execution requires a later host-routing adapter using the same Swallowtail
operation contract.

Resource-free chat may keep the existing Nucleus policy of using the
authoritative host user's home directory as a read-only context.

## Session And Tool Rules

- each new live wrapper opens a fresh Swallowtail session
- an in-memory wrapper may carry multiple turns while model, reasoning, and
  resource selection stay unchanged
- changing model, reasoning, or resource opens a fresh session with Nucleus's
  sanitized transcript migration context
- stored tool-enabled provider threads are not resumed until provider schema
  evidence permits safe tool redeclaration and Nucleus can retain the complete
  Swallowtail resume binding
- exactly the declared `task_ledger` and `task_workflow` callbacks may reach
  Nucleus execution
- callback ids, provider turn ids, Nucleus turn ids, task ids, and receipt ids
  remain distinct
- callback failure is returned to the provider without granting alternate
  execution authority

## Lifecycle And Diagnostics

- model discovery and turns remain deadline-bound
- event and callback streams are drained while the turn is active
- every terminal outcome is mapped explicitly; an empty completed response is
  an error
- turn and session cleanup are awaited; child cleanup cannot depend only on
  process drop
- default errors expose safe diagnostics, not prompts, callback payloads,
  schemas, credentials, raw provider envelopes, or filesystem paths

## Compatibility

The first slice preserves:

- adapter id `codex-app-server`
- current model and reasoning DTOs
- current `LocalCodexChatService` request, reply, history, and receipt shapes
- current task/Goal portal semantics
- current desktop behavior and stored schemas

The old Codex app-server transport is removed after focused and native parity
proof. `nucleus-agent-protocol` remains the consumer facade until a later
contract decides whether it should narrow or disappear.

## Outside This Slice

- provider or credential settings UI
- another provider
- direct-model inference
- remote-authoritative execution transport
- migrating `codex_supervision` or task-execution paths without a focused
  inventory and parity plan
- public Swallowtail versioning

The focused inventory is now complete. Contract 031 governs the separate
task-execution port and bounded workspace access profile; it does not widen
this Agent Chat slice.

## Acceptance

- Swallowtail owns Agent Chat Codex process and protocol mechanics
- Nucleus tool calls and receipts retain their current behavior
- model discovery, multi-turn chat, route changes, callback failure, deadline,
  terminal outcome, and cleanup have focused evidence
- no direct Codex app-server implementation remains in the live adapter crate
- native Agent Chat acceptance passes before the legacy transport is declared
  removed
