# T3 Code Provider Integrations

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Capture the provider integration shape found in the ignored T3 Code source
clone at `external/t3code`.

This is a specimen, not a dependency decision. Nucleus should borrow useful
boundaries and avoid inheriting T3-specific assumptions.

## Source Paths

- `external/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- `external/t3code/packages/contracts/src/providerRuntime.ts`
- `external/t3code/packages/contracts/src/providerInstance.ts`
- `external/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/CursorAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `external/t3code/apps/server/src/provider/acp/CursorAcpSupport.ts`
- `external/t3code/apps/server/src/provider/opencodeRuntime.ts`
- `external/t3code/docs/architecture/overview.md`
- `external/t3code/docs/architecture/providers.md`
- `external/t3code/docs/architecture/remote.md`

## T3 Adapter Boundary

T3 defines a provider adapter around these operations:

- `startSession`
- `sendTurn`
- `interruptTurn`
- `respondToRequest`
- `respondToUserInput`
- `stopSession`
- `listSessions`
- `hasSession`
- `readThread`
- `rollbackThread`
- `stopAll`
- `streamEvents`

Nucleus should keep this broad lifecycle shape. It is more useful than a
send-message-only abstraction because it makes approvals, input requests,
rollback, and runtime streams explicit.

## Identity Model

T3 separates provider driver kind from provider instance id.

- driver kind: implementation selector such as `codex`, `claudeAgent`,
  `cursor`, or `opencode`
- instance id: user-defined routing key for configured provider instances

That split is important for nucleus. Users will need multiple accounts,
work/personal configurations, local/remote instances, and provider-specific
environment variables without losing thread/session bindings.

T3 runtime events also carry both app-side ids and provider refs:

- `eventId`
- `provider`
- optional `providerInstanceId`
- `threadId`
- optional `turnId`
- optional `itemId`
- optional `requestId`
- optional `providerRefs.providerTurnId`
- optional `providerRefs.providerItemId`
- optional `providerRefs.providerRequestId`

Nucleus should make this dual identity model mandatory. Provider-native ids are
evidence; nucleus ids are the durable internal contract.

## Provider-Specific Findings

### Codex

T3 wraps a typed Codex app-server runtime, not a plain terminal view.

Observed shape:

- scoped runtime per session
- app-server transport errors become session-closed errors
- supports `sendTurn`, `interruptTurn`, `readThread`, `rollbackThread`, and
  approval responses
- preserves provider turn/item/request refs when available
- supports multiple configured instances through Codex home and shadow-home
  handling

Nucleus implication: Codex should be investigated as a structured runtime
first. A PTY fallback may still be useful, but it should not be the primary
adapter if stable app-server or protocol access is available.

### Claude

T3 currently wraps `@anthropic-ai/claude-agent-sdk`.

Observed shape:

- async iterable SDK message stream
- prompt queue
- resumable session id handling
- permission callbacks mapped to approval requests
- structured user input handling
- interruption support
- model and permission-mode control
- synthetic turn handling for background assistant output

Nucleus implication: the original assumption that Claude must be direct CLI/PTY
only should be treated as a research gap, not a settled rule. Nucleus should
evaluate the SDK, CLI machine boundaries, and PTY rendering separately.

### Cursor

T3 uses Cursor through ACP.

Observed shape:

- spawns `agent acp`
- uses JSON-RPC over a child process
- initializes with client capabilities
- supports session resume by provider session id
- maps modes such as plan, code/agent/default, and ask
- handles ACP permission and elicitation requests
- applies model/config options through ACP methods and Cursor extensions

Nucleus implication: Cursor should be ACP-first for the first adapter design.
The newer Cursor SDK should still be researched for cloud/programmatic
workflows, but local harness control has a concrete ACP path.

### OpenCode

T3 uses `@opencode-ai/sdk/v2` against an OpenCode server.

Observed shape:

- can connect to an external OpenCode server or spawn a scoped local server
- waits for server-ready output
- creates an SDK client for a base URL and directory
- tracks OpenCode session id
- maps permission and question events to approval/user-input requests
- supports abort, read, and rollback through SDK calls

Nucleus implication: OpenCode should be modeled as server/SDK-first and
ACP-capable. Do not reduce it to a terminal adapter.

## Remote Runtime Lesson

T3 remote docs keep remoteness at the environment/access layer.

The T3 server owns provider state, projects/threads, terminals, filesystem,
git, and process runtime. Clients connect through direct WebSocket, tunnel, or
SSH-forwarded access methods.

Nucleus should preserve the same separation but use its stronger project model:

- execution environment: one nucleus server
- project: durable nucleus project record, not just one workspace root
- access endpoint: one way to reach the server
- control plane: desktop, web, mobile, or CLI client

## Risks In T3 Shape

- T3 project identity is still rooted in a `workspaceRoot`; nucleus needs
  durable multi-repo project identity.
- T3’s historical docs mention Codex-only implementation in places, while the
  current code has multiple providers; nucleus docs should avoid stale provider
  claims by keeping an explicit inventory.
- T3 is TypeScript/Effect-based; nucleus needs a Rust-native contract and may
  need bridge processes for TypeScript SDK-only providers.
- Provider-specific event normalization is substantial. Nucleus should avoid
  pretending the adapter layer is a thin wrapper.

## Promotion Targets

Promoted into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
