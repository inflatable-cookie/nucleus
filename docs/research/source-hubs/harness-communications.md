# Harness Communications Source Hub

Status: open
Owner: Tom
Updated: 2026-06-15

## Purpose

Collect evidence for the nucleus harness adapter model before implementation.

## Sources

- T3 Code source: `https://github.com/pingdotgg/t3code`
- Agent Client Protocol: `https://agentclientprotocol.com/get-started/introduction`
- ACP GitHub repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- OpenCode CLI docs: `https://opencode.ai/docs/cli/`
- OpenCode ACP docs: `https://opencode.ai/docs/acp/`
- Cursor SDK docs: `https://cursor.com/docs/sdk/typescript`
- Cursor SDK announcement: `https://cursor.com/blog/typescript-sdk`
- Cursor CLI docs: `https://cursor.com/docs/cli/overview`
- Cursor CLI ACP docs: `https://cursor.com/docs/cli/acp`
- Claude Code quickstart: `https://code.claude.com/docs/en/quickstart`
- Claude Code CLI reference: `https://code.claude.com/docs/en/cli-reference`
- Claude Agent SDK overview:
  `https://code.claude.com/docs/en/agent-sdk/overview`
- Claude Agent SDK TypeScript reference:
  `https://code.claude.com/docs/en/agent-sdk/typescript`
- Claude Agent SDK hosting:
  `https://code.claude.com/docs/en/agent-sdk/hosting`
- Codex CLI docs: `https://developers.openai.com/codex/cli`
- Kimi Code source/docs: `https://github.com/MoonshotAI/kimi-code`
- Kimi Code ACP reference:
  `https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.md`
- Kimi Code sessions:
  `https://moonshotai.github.io/kimi-code/en/guides/sessions.md`
- Kimi CLI legacy source/docs: `https://github.com/MoonshotAI/kimi-cli`
- Kimi Agent SDK: `https://github.com/MoonshotAI/kimi-agent-sdk`
- Pi docs: `https://pi.dev/docs/latest`
- Pi SDK docs: `https://pi.dev/docs/latest/sdk`
- Pi RPC docs: `https://pi.dev/docs/latest/rpc`
- Pi providers docs: `https://pi.dev/docs/latest/providers`

## Research Questions

- Which harnesses provide stable programmatic APIs?
- Which harnesses should be ACP-first?
- Which harnesses require direct CLI/PTY control?
- Which identity model does each harness use for sessions, messages, turns, and
  tool calls?
- How does each harness expose cancellation, resume, checkpointing, and
  permissions?
- What did T3 Code do well?
- Where does T3 Code's provider model risk message identity collisions or
  performance bottlenecks?
- What adapter capabilities should nucleus expose without forcing false
  uniformity?
- Which tools are full harnesses versus model/provider backends?
- Which tools expose programmatic APIs strong enough for a native adapter?

## Initial Findings

- ACP should be treated as a first-class protocol family, with local stdio and
  remote transports researched separately.
- T3 Code's provider adapter contract has useful lifecycle breadth:
  start/send/interrupt/approval/user-input/stop/list/read/rollback/stream.
- T3 Code separates provider driver kind from provider instance id. Nucleus
  should adopt this split so multiple accounts or configurations can share one
  driver without corrupting session routing.
- T3 runtime events preserve both app-side ids and provider-native refs.
  Nucleus should make this dual identity model mandatory.
- Codex should be investigated as a structured app-server/runtime integration
  before falling back to PTY.
- Claude should start SDK-sidecar-first when deployment constraints allow it.
  Direct CLI and PTY remain explicit fallback paths.
- Cursor has a concrete ACP path through `agent acp`; treat Cursor CLI as
  ACP-first while separately evaluating the Cursor SDK and non-ACP headless CLI
  workflows.
- OpenCode has a server/SDK path in T3 and public ACP support. Treat it as
  server/SDK-first for nucleus, with ACP as a second transport path.
- Cursor CLI is a separate research target from Cursor SDK. The CLI is a
  terminal agent for local, CI, and scripted workflows; T3 proves an ACP route
  exists through `agent acp`.
- Kimi Code supports ACP through `kimi acp`, MCP tool configuration, and a
  separate Kimi Agent SDK with Go, Node, and Python clients that keep the CLI
  runtime as the execution engine.
- Pi is a minimal terminal coding harness with TypeScript extensions, provider
  configuration, SDK access, and RPC mode over stdin/stdout. It should be
  researched as a first-class harness, not just an OpenAI-compatible model
  wrapper.
- Kimi Code should start ACP-first, with Wire and SDK-sidecar support kept as
  second paths if ACP lacks event identity or approval fidelity.
- Kimi ACP provides enough first-pass identity to plan an adapter: ACP session
  ids, JSON-RPC request ids, raw tool-call ids, turn-prefixed ACP tool-call
  ids, approval option ids, and question option ids.
- Pi should start RPC-first. Its SDK is richer inside a Node process, but RPC
  is language-agnostic and gives Rust better isolation.
- Pi RPC events do not include event ids, so nucleus must synthesize them from
  adapter instance, Pi session, session file, RPC stream generation,
  monotonic sequence, event type, and stable native ids inside payloads.
- Pi command request ids correlate command responses only. They must not be
  treated as runtime event ids.
- Pi session files are a separate replay identity namespace with session
  header UUIDs and tree entries linked by `id` and `parentId`.
- Kimi SDK event streams expose turns, steps, content parts, tool calls,
  approvals, status updates, subagent events, and interruption.
- Cursor ACP should preserve ACP session ids, JSON-RPC request ids, message ids
  where present, tool-call ids, permission request ids, and Cursor extension
  methods. Missing ACP message ids require marked synthetic nucleus item ids.
- OpenCode server/SDK should preserve session ids, message ids, part ids,
  permission ids, question ids, raw event payloads, and explicit server
  ownership mode.
- GLM/Z.ai, MiniMax, DeepSeek, OpenRouter, and OpenCode Zen are primarily
  model/provider-routing surfaces for this contract unless paired with a
  harness that exposes sessions, tools, approvals, and event identity.
- T3 Code should be used as a specimen for provider process handling and
  event normalization, not copied as product architecture.

## Harness Candidate Matrix

| Candidate | Current signal | Initial nucleus posture |
| --- | --- | --- |
| Codex | CLI plus structured runtime observed through T3. | Structured runtime first; PTY fallback. |
| Claude Code | Official Agent SDK plus CLI controls; SDK observed through T3. | SDK-sidecar-first; CLI/PTY fallback. |
| Cursor CLI | Official CLI plus ACP route observed in T3. | ACP-first; CLI/headless as secondary. |
| Cursor SDK | TypeScript SDK for programmatic agents. | Research sidecar/cloud workflows separately. |
| OpenCode | SDK/server observed in T3; ACP public docs. | Server/SDK-first; ACP comparison needed. |
| Kimi Code CLI | ACP via `kimi acp`; single-binary terminal agent. | ACP-first; Wire/SDK sidecar secondary. |
| Kimi Agent SDK | Go, Node, Python clients over Kimi CLI runtime. | Sidecar if ACP and Wire are insufficient. |
| Pi | Terminal harness with SDK and RPC mode. | RPC-first; SDK sidecar if needed. |

## Runtime Dossiers

- `docs/research/specimen-dossiers/codex-runtime-boundary.md`
- `docs/research/specimen-dossiers/cursor-cli-runtime-boundary.md`
- `docs/research/specimen-dossiers/opencode-runtime-boundary.md`
- `docs/research/specimen-dossiers/claude-runtime-boundary.md`
- `docs/research/specimen-dossiers/kimi-runtime-boundary.md`
- `docs/research/specimen-dossiers/pi-runtime-boundary.md`

## Model/Provider Routing Surfaces

These are tracked separately in
`docs/research/source-hubs/provider-routing-and-model-surfaces.md`:

- GLM/Z.ai
- MiniMax
- DeepSeek
- OpenRouter
- OpenCode Zen

## T3 Code Source Pass

First-pass dossier:

- `docs/research/specimen-dossiers/t3-code-provider-integrations.md`

Promoted memo:

- `docs/research/translation-memos/harness-adapter-contract-first-pass.md`

Important local source paths:

- `external/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- `external/t3code/packages/contracts/src/providerRuntime.ts`
- `external/t3code/packages/contracts/src/providerInstance.ts`
- `external/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/CursorAdapter.ts`
- `external/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `external/t3code/apps/server/src/provider/opencodeRuntime.ts`
- `external/t3code/docs/architecture/remote.md`

## Local Specimen

Expected ignored clone path:

```text
external/t3code
```

If cloning fails, log the failure here and continue with public docs until the
source is available.

## Promotion Targets

- `docs/architecture/system-architecture.md`
- `docs/architecture/system-inventory.md`
- `docs/contracts/002-harness-adapter-contract.md`

## Next Task

Draft projection storage Rust surface boundaries.
