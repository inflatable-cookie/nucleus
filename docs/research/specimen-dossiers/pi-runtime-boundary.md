# Pi Runtime Boundary

Status: promoted-implementation-ready
Owner: Tom
Updated: 2026-06-15

## Purpose

Capture Pi integration options for nucleus.

## Sources

- Pi docs: `https://pi.dev/docs/latest`
- Pi SDK docs: `https://pi.dev/docs/latest/sdk`
- Pi RPC docs: `https://pi.dev/docs/latest/rpc`
- Pi providers docs: `https://pi.dev/docs/latest/providers`
- Pi custom provider docs: `https://pi.dev/docs/latest/custom-provider`
- Pi session format docs: `https://pi.dev/docs/latest/session-format`
- Pi security docs: `https://pi.dev/docs/latest/security`

## Integration Options

### RPC

Pi RPC mode is a strong language-agnostic target.

Start command:

```text
pi --mode rpc
```

Useful options:

- `--provider`
- `--model`
- `--name`
- `--no-session`
- `--session-dir`

Protocol shape:

- JSON objects to stdin, one per line
- responses on stdout with `type: "response"`
- events on stdout as JSON lines
- optional request `id` echoed in responses
- strict LF record delimiter

Required first adapter commands:

- `get_state`
- `get_messages`
- `prompt`
- `steer`
- `follow_up`
- `abort`
- model and thinking setters
- queue mode setters
- compaction start/abort
- retry
- bash execution
- session commands, including new/switch/fork where exposed
- command discovery

`get_state` exposes the active `sessionFile`, `sessionId`, model, thinking
level, streaming state, compaction state, session name, and pending message
count.

RPC events include:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `queue_update`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `extension_error`

Important identity constraint: Pi RPC events do not include an event `id`.
Command request ids correlate requests with responses only. They are not event
ids.

Nucleus must synthesize durable event ids from:

- nucleus adapter instance id
- Pi `sessionId` when known
- Pi `sessionFile` when known
- stream generation id for the owned RPC process
- monotonic event sequence inside that stream generation
- event type
- provider-native ids inside the payload, such as `toolCallId`

Content hashes may be stored as diagnostics, but must not be the sole identity
source. Replayed session-file entries already have their own entry ids and
must not reuse live stream ids.

### SDK

Pi SDK is included in `@earendil-works/pi-coding-agent`.

Useful `AgentSession` operations:

- `prompt`
- `steer`
- `followUp`
- `subscribe`
- `sessionFile`
- `sessionId`
- `setModel`
- `setThinkingLevel`
- `navigateTree`
- `compact`
- `abortCompaction`
- `abort`
- `dispose`

`AgentSessionRuntime` owns session replacement:

- `newSession`
- `switchSession`
- `fork`
- clone/fork flows
- `importFromJsonl`

Important SDK constraint: subscriptions bind to the current `AgentSession`.
After runtime replacement, callers must subscribe again and rebind extensions.

SDK is preferred only if nucleus accepts a Node sidecar or later embeds a
TypeScript runtime boundary.

### Session Files

Pi sessions are JSONL files under:

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Session entries form a tree through `id` and `parentId`.

Current session file version is v3. Existing sessions auto-migrate when loaded.

The first file entry is a session header with a UUID session id and cwd. It is
metadata, not a tree entry. Later entries carry 8-character entry ids and
`parentId` links. Branching creates new children from earlier entries, and the
leaf is the current position in the tree.

Important entry types:

- session header with UUID and cwd
- message entries
- model changes
- thinking-level changes
- compaction entries
- branch summaries
- custom entries

## Nucleus Decision

Start Pi as RPC-first.

Reasons:

- language-agnostic
- process isolation
- explicit request/response plus event stream
- strong session persistence model
- easier Rust integration than Node SDK

Keep SDK sidecar as a second path if RPC cannot expose enough state or
extension control.

PTY bridge remains a fallback for visual terminal rendering only.

## Risks

- No built-in sandbox. Pi tools and extensions run with Pi process
  permissions, so nucleus must control process environment and working
  directory carefully.
- RPC events lack event ids.
- SDK event subscriptions are tied to a specific session object and must be
  rebound after session replacement.
- Extensions can change behavior deeply; adapter capability snapshots must
  include loaded extension/command surfaces where possible.

## Contract Implications

- Pi requires synthetic event identity.
- Pi request ids must not be treated as event ids.
- Pi adapter should expose session-file path and session id.
- Live stream event ids and replayed session-file entry ids are separate
  identity namespaces.
- Pi adapter should expose tree navigation/fork capabilities separately from
  generic rollback.
- Pi queue, retry, compaction, bash, and extension UI surfaces should be
  explicit adapter capabilities.
- Pi adapter must report sandbox status as external/none unless nucleus wraps
  the process in its own sandbox.
- Pi provider/model selection belongs partly to the model-route contract.

## Next Task

Draft task-level agent assignment and model preference semantics.
