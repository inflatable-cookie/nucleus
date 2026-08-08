# 030 Swallowtail Agent Runtime Integration Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-08-07

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

## Configured Provider Instances

Swallowtail Contract 047 owns the portable configured-provider-instance
catalogue and its admission rules. Each Nucleus runtime adapter prepares its
exact facade and model-catalogue route, supplies the bound catalogue outcome,
and returns one admitted instance record. The Nucleus runtime registry
assembles those records into one Swallowtail catalogue and retains only the
registry adapter binding needed to start the selected route.

Nucleus may serialize a product projection of that catalogue. It must preserve
configured instance, revision, facade, provider, model, readiness, and safe
credential-posture truth. Product display names and ordering may be added, but
TypeScript must not infer identities, route capabilities, authentication, or
readiness. Target references, credential references, raw probes, operation
handles, and provider payloads remain absent.

Catalogue assembly and refresh are read-only preparation work. The catalogue
does not select a provider, run a session, choose defaults, retry, fail over,
or grant provider effects.

## First Adoption Slice

The first slice replaced the `codex-app-server` implementation behind the
existing `AgentSessionRuntime` and `AgentLiveSession` facade. The configured-
provider catalogue adoption later replaced the model-only Tauri query with one
safe Nucleus product projection of the Swallowtail catalogue. Prompts and the
two Nucleus tool portals remain independent of provider selection.

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
- changing explicit normal or plan harness mode opens a fresh session by the
  same rule; Nucleus passes `SessionOptions::with_harness_mode` during
  preparation and records selected and effective mode
- changing configured provider instance or protocol facade opens a fresh
  session by the same rule; the selected instance must be `Ready` in the
  current admitted catalogue and the selected model must belong to it
- plan harness mode, `ActivityKind::Plan`, and an open-ended planning
  conversation are distinct and must not be inferred from one another
- stored tool-enabled provider threads are not resumed until provider schema
  evidence permits safe tool redeclaration and Nucleus can retain the complete
  Swallowtail resume binding
- exactly the declared `task_ledger` and `task_workflow` callbacks may reach
  Nucleus execution
- callback ids, provider turn ids, Nucleus turn ids, task ids, and receipt ids
  remain distinct
- callback failure is returned to the provider without granting alternate
  execution authority

Agent Chat opts into Swallowtail's prepared user-input exchange. A
`CallbackRequestKind::HarnessUserInput` request is projected without
provider-native parsing, persisted before display, and resolved through its
original responder exactly once. Nucleus owns the safe rendezvous, durable wait
state, desktop answer route, cancellation policy, and restart truth.
Swallowtail owns request validation, provider correlation, response
translation, callback lifecycle, and cleanup.

Task execution keeps its current explicit unsupported/wait-state policy until
its own contracts admit interactive answers. It must recognize the current
portable callback variant and fail honestly rather than relying on a removed
Swallowtail name.

The plan-decision route rides the existing Agent Chat session rules. Accepting
a proposed plan opens a Normal-mode prepared session per Contract 010's
Effective Session Mode rule. When the settled route differs from the live
session route, the existing route-mismatch rule already opens a fresh session
with bounded message-only migration context; no mid-session mode switch exists
in Swallowtail and Nucleus does not fake one.

## Lifecycle And Diagnostics

- before model-catalog or session preparation, Nucleus passes one
  host-approved executable target, saved-login environment, stable instance
  identity, and caller-asserted access evidence to Swallowtail's prepared Codex
  facade
- the facade probes the target and binds the exact observed `codex.cli` version
  into the configured instance and operation requirements; discovery failure
  stops before app-server launch
- Nucleus must not substitute a compiled-in, latest-known, or guessed Codex
  version for host evidence
- the facade binds Swallowtail's `Ambient` harness-configuration posture
  because Nucleus launches Codex with the host-approved saved-login environment
  and accepts its ordinarily visible configuration sources
- ambient configuration agreement grants no configuration discovery,
  mutation, migration, installation, or deletion authority
- Agent Chat and the confirmed smoke use the facade's read-only session profile;
  the profile binds one canonical access policy into immutable preflight and
  the session-open request
- Nucleus does not reconstruct configured instances, capability requirements,
  version bindings, configuration posture, or session-plan agreement
- model discovery and turns remain deadline-bound
- the normal Agent Chat turn deadline is 180 seconds
- `NUCLEUS_AGENT_CHAT_TURN_TIMEOUT_MS` may select a shorter positive deadline
  at process start for bounded proof; zero, invalid, or longer values fail
  before provider work
- event and callback streams are drained while the turn is active
- each prepared Agent Chat operation must expose an `Available`
  observable-activity profile before provider effects
- the Nucleus adapter forwards only Swallowtail's bounded portable activity
  observations with their runtime event sequence; it does not parse native
  Codex event names or expose raw payloads
- Nucleus preserves each observation's actor, task-list replacement snapshot,
  and subagent snapshot rather than flattening them to prose
- Nucleus maintains one Swallowtail `SubagentDirectoryProjection` per runtime
  operation and persists only the bounded product projection needed for child
  attribution and navigation
- provider task lists remain provider work evidence and never become durable
  Nucleus Tasks by display alone
- a consumer activity-projection failure requests turn cancellation and remains
  distinct from provider failure
- a Nucleus-owned thread-safe cancellation signal wakes the active adapter
  turn loop and requests cancellation through Swallowtail's turn handle
- native cancellation is scoped by exact project and conversation identity and
  does not wait for the serialized chat-service mutex
- cancellation request, provider cancellation, deadline expiry, runtime
  failure, and cleanup failure remain distinct
- every terminal outcome is mapped explicitly; an empty completed response is
  an error
- turn and session cleanup are awaited; child cleanup cannot depend only on
  process drop
- default errors expose safe diagnostics, not prompts, callback payloads,
  schemas, credentials, raw provider envelopes, or filesystem paths
- `NUCLEUS_SWALLOWTAIL_DEBUG=1` (also `true` / `yes` / `on`) may register an
  opt-in Swallowtail `DiagnosticObserver` on the Codex host that prints
  restricted debug observations to stderr; ordinary product runs leave the
  observer unregistered and must not use debug observations for control flow

## Application Proof Profile

Nucleus may launch the normal desktop entry under the explicit data-root,
proof-fixture, and deadline settings in Contract 008 and this contract. The
profile changes only Nucleus-owned storage, bootstrap resource selection, and
deadline policy. It does not alter Codex home, credentials, ambient harness
configuration, Swallowtail access policy, or workspace authority.

The proof fixture is an explicit disposable Git repository. It is valid only
with an isolated data root, replaces inferred Nucleus-source bootstrap
selection for that fresh state, and grants no write authority.

Proof evidence may retain generated scenario ids, exact version and route
observations, expected and observed terminal classes, event and callback
counts, elapsed time, usage/rate summaries when supplied, and cleanup state.
It must not retain credentials, prompts, assistant output, raw provider
payloads or streams, absolute user paths, or raw provider thread/turn ids.

The deterministic readiness lane must pass without authentication or provider
calls. Live catalogue and turn execution remain a separate operator gate.

## Compatibility

The first slice preserves:

- adapter id `codex-app-server`
- current model and reasoning DTOs
- current `LocalCodexChatService` request, reply, history, and receipt shapes
- current task/Goal portal semantics
- current desktop behavior and stored schemas

The later observable-activity slice is additive to stored session, turn, and
message records. It adds separate activity records, sanitized turn status to
history DTOs, and one caller-window live event. The terminal reply, callbacks,
cancellation, receipts, and existing message history remain authoritative and
do not move into Swallowtail.

Provider item lifecycle and turn terminal status remain separate. Nucleus may
use its durable cancelled, timed-out, or failed turn status to settle a
still-open item in transcript presentation. It does not persist a synthetic
portable activity observation or claim that the provider emitted an item
completion.

`nucleus-agent-protocol` may carry Swallowtail's provider-neutral
`ActivityObservation` across the adapter boundary. It must not define a second
portable activity vocabulary or expose provider-native payloads.

Durable Nucleus activity projections use `ActivityObservation::key()` without
reconstructing, rewriting, or parsing provider identity. One portable key
upserts one retained activity row; equal provider or activity references under
different runtime operations remain separate. Nucleus supplies run and turn
ids that remain unique for as long as an earlier retained projection can refer
to them. Conversation, provider-thread, canonical turn, and transcript-message
identity stay Nucleus-owned and do not become aliases for `ActivityKey`.

The same rule applies to `HarnessUserInputRequest`,
`HarnessUserInputResponse`, `TaskListSnapshot`, actor attribution, and
subagent topology. Nucleus may add product correlation and persistence
envelopes around these types; it must not fork their portable semantics.

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
- typed questions remain answerable while the rest of the UI stays responsive
- duplicate, stale, cancelled, timed-out, restarted, and post-terminal answers
  fail deterministically
- selected and effective plan mode agree before provider effects
- task-list status and priority survive persistence and replay
- child attribution and unknown topology survive persistence and replay
