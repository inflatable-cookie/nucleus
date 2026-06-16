# Kimi Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Capture Kimi CLI and Kimi Agent SDK integration options for nucleus.

## Sources

- Kimi Code CLI README: `https://github.com/MoonshotAI/kimi-code`
- Kimi Code ACP reference:
  `https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.md`
- Kimi Code interaction and approvals:
  `https://moonshotai.github.io/kimi-code/en/guides/interaction.md`
- Kimi Code sessions:
  `https://moonshotai.github.io/kimi-code/en/guides/sessions.md`
- Kimi CLI README: `https://github.com/MoonshotAI/kimi-cli`
- Kimi Code changelog:
  `https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html`
- Kimi Agent SDK: `https://github.com/MoonshotAI/kimi-agent-sdk`
- Python SDK quickstart:
  `https://github.com/MoonshotAI/kimi-agent-sdk/blob/main/guides/python/quickstart.md`
- Go SDK quickstart:
  `https://github.com/MoonshotAI/kimi-agent-sdk/blob/main/guides/go/quickstart.md`
- Node SDK README:
  `https://github.com/MoonshotAI/kimi-agent-sdk/blob/main/node/agent_sdk/README.md`

## Integration Options

### ACP

Kimi Code CLI documents ACP support through:

```text
kimi acp
```

ACP is the best first nucleus posture because it aligns with the adapter
contract and avoids depending on SDK language/runtime choices.

Current ACP evidence:

- `kimi acp` is JSON-RPC over stdin/stdout.
- The process prints no banner; logs go to stderr and diagnostic log files.
- `initialize` returns agent info, auth methods, and capabilities.
- `authenticate` supports the terminal login flow.
- `session/new`, `session/load`, `session/resume`, `session/list`,
  `session/prompt`, `session/cancel`, `session/set_mode`, and
  `session/set_config_option` are implemented.
- `session/load` replays history through `session/update`.
- `session/resume` rehydrates without replay.
- `session/update` streams agent messages, tool calls, plans, config option
  updates, and command updates.
- `session/request_permission` is shared for tool approvals and question
  elicitation.
- file read/write reverse RPC is implemented.
- terminal reverse RPC is not connected; shell commands execute locally.
- ACP-supplied MCP servers are forwarded for HTTP, SSE, and stdio transports.
- ACP `acp`-transport MCP servers are discarded with a warning.

Identity and correlation evidence:

- Kimi ACP session id maps to the underlying Kimi session id.
- The adapter prefixes tool call ids with turn id as `${turnId}:${toolCallId}`
  so repeated raw tool ids do not collide across turns.
- Approval requests preserve the raw SDK tool-call id and expose stable ACP
  option ids.
- Question elicitation uses a separate option-id namespace.
- History replay synthesizes turn ids while preserving raw tool-call ids.

This is enough for a first implementation plan to stay ACP-first.

### Wire

Legacy Kimi CLI documents Wire mode as a JSON-RPC 2.0 protocol over
stdin/stdout with one JSON message per line. It is the low-level message layer
used internally by the terminal UI and ACP server.

Wire is worth keeping as a second research path because it may expose richer
Kimi-native events than ACP. It should not displace ACP until the Rust adapter
needs behavior ACP cannot carry.

The older docs also reference `MoonshotAI/kimi-agent-rs`, an experimental Rust
Wire server. That is not a stable nucleus dependency yet, but it is relevant
to future Rust-native adapter research.

### SDK

Kimi Agent SDK exposes the Kimi Code/Kimi CLI runtime in Go, Node, and Python.
The SDKs reuse CLI configuration, tools, skills, and MCP servers.

Useful SDK concepts:

- session
- turn
- streamed steps/messages
- content parts
- tool calls
- tool results
- approval requests
- token/context status updates
- subagent events
- turn interruption
- session listing
- session parsing

Node SDK surface includes:

- `createSession({ workDir, sessionId, model, thinking, yoloMode, executable, env })`
- `session.prompt(...)`
- async turn events
- `turn.interrupt()`
- `turn.approve(requestId, response)`
- `listSessions`
- `parseSessionEvents`
- Kimi paths for config, MCP config, sessions, and shadow git dirs

Go SDK surface includes:

- `NewSession`
- `Prompt`
- streamed `Turn.Steps`
- `Turn.Err`
- `Turn.Result`
- `Turn.Usage`
- `Turn.Cancel`

Python SDK exposes a high-level `prompt()` API and a lower-level `Session`
API. The `Session` API supports multiple prompts in one session, resume, raw
wire messages, and approvals.

## Nucleus Decision

Start Kimi Code as ACP-first.

Keep Wire and SDK sidecar support as second paths if ACP lacks enough event
identity or approval fidelity.

Possible implementation paths:

- ACP stdio adapter: spawn `kimi acp`.
- Wire stdio adapter: spawn `kimi --wire` or future compatible Kimi agent.
- Node sidecar: use the Kimi Code SDK only if ACP and Wire are insufficient.
- Go sidecar or FFI boundary: evaluate only if ACP, Wire, and Node sidecar are
  weak.
- PTY bridge: fallback for terminal-native rendering only.

## Risks

- Legacy Kimi CLI is evolving into Kimi Code CLI; docs and command behavior may
  diverge.
- The old `kimi-cli` repo is being wound down; Kimi Code is now the primary
  target.
- SDKs are thin clients over the CLI runtime, so CLI version drift affects SDK
  behavior.
- SDKs expose rich event types, but Rust-native direct integration is not
  currently evident.
- YOLO mode auto-approves tool calls and should not be the default in nucleus.
- Terminal reverse-RPC is not connected in the Kimi Code ACP adapter, so shell
  commands run in the Kimi process environment.

## Contract Implications

- Kimi needs `transport=acp-stdio`, possible `transport=wire-stdio`, and
  possible `transport=sdk-sidecar` capability paths.
- Adapter config must include executable path, environment, model, thinking
  mode, permission mode, plan mode, work dir, home/config path, and optional
  session id.
- Adapter events must preserve ACP session ids, JSON-RPC request ids, tool-call
  ids, turn-prefixed ACP tool-call ids, approval option ids, and question
  option ids.
- Kimi session parsing and Wire logs may support history hydration, but
  `session/load` is the first ACP-native replay path.

## Next Task

Draft SCM/forge adapter implementation readiness plan.
