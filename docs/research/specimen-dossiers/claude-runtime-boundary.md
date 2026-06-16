# Claude Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Purpose

Capture Claude Code CLI and Claude Agent SDK integration options for nucleus.

## Sources

- Claude Code quickstart: `https://code.claude.com/docs/en/quickstart`
- Claude Code CLI reference: `https://code.claude.com/docs/en/cli-reference`
- Claude Agent SDK overview:
  `https://code.claude.com/docs/en/agent-sdk/overview`
- Claude Agent SDK TypeScript reference:
  `https://code.claude.com/docs/en/agent-sdk/typescript`
- Claude Agent SDK permissions:
  `https://code.claude.com/docs/en/agent-sdk/permissions`
- Claude Agent SDK sessions:
  `https://code.claude.com/docs/en/agent-sdk/sessions`
- Claude Agent SDK hosting:
  `https://code.claude.com/docs/en/agent-sdk/hosting`
- Local Claude Code binary: `claude --version` returned `2.1.173`
- T3 Code local specimen:
  `external/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- T3 Code local driver:
  `external/t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts`

## Integration Options

### SDK Sidecar

Claude should start as SDK-sidecar-first if provider terms and deployment
constraints allow it.

Reasons:

- the Agent SDK exposes structured streaming messages
- it supports streaming input through an async iterable prompt
- it exposes permission modes and a `canUseTool` callback
- it supports session id capture and resume
- it exposes interruption through the query handle
- it can change model and permission mode while a streaming session is active
- it supervises a `claude` subprocess, which fits the nucleus server-owned
  process model

The Rust server should not embed TypeScript as core logic. The likely shape is
a small sidecar process with a narrow protocol owned by nucleus.

Required sidecar record fields:

- executable or bundled SDK binary path
- sidecar package/version
- configured Claude home or config directory
- working directory
- setting sources
- environment references
- model and effort settings
- permission mode
- additional directories
- MCP configuration
- resume/session id

### Direct CLI

Claude CLI remains a required fallback and test surface.

Useful CLI controls:

- interactive terminal sessions through `claude`
- non-interactive `claude -p`
- structured `--output-format json` and `--output-format stream-json`
- streaming input through `--input-format stream-json`
- `--resume`, `--continue`, `--fork-session`, and `--session-id`
- `--permission-mode`
- `--allowedTools` and `--disallowedTools`
- `--mcp-config` and `--strict-mcp-config`
- `--add-dir`
- `--model`, `--fallback-model`, and `--effort`

Direct CLI is useful for one-shot automation, diagnostics, and environments
where a sidecar is not allowed.

### PTY Bridge

PTY remains the fallback when the user needs the native Claude terminal
experience or when structured control is unavailable.

PTY support must be explicit terminal rendering. It must not claim structured
message, approval, or tool-call identity unless those ids are available from a
parallel structured stream.

## T3 Code Findings

T3 uses the Claude Agent SDK as a runtime adapter.

Useful patterns:

- per-instance isolated home/config handling
- capability/account probing before use
- generated or resumed Claude session ids
- prompt queue feeding SDK streaming input
- provider-native refs retained beside app ids
- permission callback mapped into app-owned approval records
- `AskUserQuestion` mapped into structured user input
- `ExitPlanMode` treated as plan output rather than an unchecked tool action
- active query interrupt mapped to turn interruption
- in-session model and permission changes
- local transcript snapshot for read operations

Important limits:

- rollback in the T3 adapter is local in-memory turn splicing, not a proven
  provider-native rollback
- T3's Node SDK integration should be treated as a specimen, not imported as
  product architecture
- the SDK still owns a Claude subprocess and local transcript files, so process
  and disk-state recovery must be designed explicitly

## Identity Rules

Nucleus must preserve these identity layers where available:

- nucleus adapter instance id
- nucleus session id
- Claude session id
- Claude resume id
- SDK system/message UUIDs
- assistant message id
- content block id
- tool-use id
- permission request id
- structured user-input request id
- nucleus turn id
- SDK result session id
- resume cursor metadata, including resume point when available

If a CLI/PTY fallback cannot expose stable message or tool ids, the adapter
must mark those ids as synthetic or unsupported.

## Lifecycle Mapping

Initial mapping:

- create: start a new SDK query with a generated session id
- attach: reconnect only through a stored nucleus session record
- resume: pass the Claude session id through SDK `resume` or CLI `--resume`
- send turn: enqueue a streaming prompt to the active SDK query
- steer: enqueue an extra message while a turn is running only when the adapter
  declares support
- interrupt: call the SDK query interrupt method or terminate/interrupt the
  owned CLI process
- close: close the SDK query and owned subprocess tree
- read snapshot: read the nucleus transcript projection plus provider refs
- rollback: unsupported provider-native unless later evidence proves it
- respond to approval: resolve the SDK permission callback
- respond to user input: resolve the structured question callback

## Permission Model

Claude exposes meaningful permission modes. Nucleus should preserve them as
provider capabilities, not flatten them into a generic boolean.

Initial mapped modes:

- default
- dontAsk
- acceptEdits
- bypassPermissions
- plan
- auto

`bypassPermissions` must require an explicit server-side policy decision. It
must not be the default.

## Recovery Model

Claude sessions persist conversation state on local disk by default. The Agent
SDK can also use external session storage.

Nucleus must record:

- which configured Claude home/config directory was used
- which work directory was used
- whether transcripts are local-only or mirrored externally
- whether recovery is resume-by-id, continue-most-recent, or impossible
- whether sidecar restart preserves the same Claude session id

Session recovery is not filesystem rollback. File checkpointing remains a
separate capability.

## Nucleus Decision

Start Claude as SDK-sidecar-first, with direct CLI and PTY fallbacks kept in
the adapter contract.

The sidecar route gives the best first-pass identity, permission, and lifecycle
surface. The CLI route remains necessary for diagnostics, one-shot tasks,
environments that reject sidecars, and native terminal rendering.

## Risks

- The TypeScript SDK requires a sidecar or another non-Rust bridge.
- SDK package and Claude Code binary versions must be tracked per adapter
  instance.
- Provider terms and authentication flows may constrain remote deployment.
- Local transcript state can be lost if the server runs in an ephemeral
  environment without explicit storage.
- PTY fallback cannot safely pretend to have structured message identity.

## Contract Implications

- Claude needs `transport=sdk-sidecar`, `transport=cli-structured`, and
  `transport=cli-terminal-bridge` capability paths.
- Adapter registry records must include sidecar process and Claude config
  paths.
- Session lifecycle must separate resume, continue-most-recent, fork, and
  provider-native rollback.
- Permission mode and approval callback support are per-instance capabilities.
- Recovery state must report whether transcript storage is local-only or
  mirrored.

## Next Task

Draft management projection file model.
