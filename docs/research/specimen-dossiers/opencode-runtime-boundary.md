# OpenCode Runtime Boundary

Status: promoted-first-pass
Owner: Tom
Updated: 2026-06-15

## Question

Should OpenCode start server-SDK-first, ACP-first, or both?

## Sources

- OpenCode CLI docs: `https://opencode.ai/docs/cli/`
- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode SDK docs: `https://opencode.ai/docs/sdk/`
- OpenCode ACP docs: `https://opencode.ai/docs/acp/`
- OpenCode permissions docs: `https://opencode.ai/docs/permissions/`
- OpenCode config docs: `https://opencode.ai/docs/config/`
- OpenCode providers docs: `https://opencode.ai/docs/providers/`
- T3 OpenCode runtime:
  `external/t3code/apps/server/src/provider/opencodeRuntime.ts`
- T3 OpenCode adapter:
  `external/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- T3 OpenCode driver:
  `external/t3code/apps/server/src/provider/Drivers/OpenCodeDriver.ts`
- Local OpenCode binary: `opencode --version` returned `1.14.48`.

## Finding

OpenCode should start server/SDK-first.

ACP remains a supported second path because OpenCode documents `opencode acp`
as an ACP-compatible stdio subprocess. It should not be the first nucleus path
while the HTTP server and SDK expose richer session, message, event,
permission, revert, diff, provider, and file APIs.

## Server Boundary

OpenCode exposes a headless HTTP server through `opencode serve`.

The server is the right first boundary for nucleus because it exposes:

- session create, list, get, delete, status, fork, abort, share, diff,
  summarize, revert, unrevert, and permission response endpoints
- message list, get, prompt, async prompt, command, and shell endpoints
- provider/model, file, command, auth, and event APIs
- server-sent event subscription through the SDK

The adapter must distinguish two server ownership modes:

- external server: configured URL, not owned by nucleus
- scoped local server: spawned by nucleus and killed when the adapter/session
  scope closes

T3 already implements this split. It reuses `serverUrl` when configured and
otherwise spawns `opencode serve`, watches ready output, and binds the child
process lifetime to an Effect scope.

## SDK Boundary

The TypeScript SDK is a typed client for the OpenCode server.

Nucleus should initially use a sidecar or bridge if Rust cannot consume the
SDK directly. The boundary must still be server-shaped:

- base URL
- directory
- optional basic auth
- SDK method name
- provider-native ids
- event stream
- typed failures

T3 uses `@opencode-ai/sdk/v2`, creates a client from base URL and directory,
and sends auth through a Basic header for external password-protected servers.

## ACP Boundary

OpenCode ACP is real and should stay in scope.

Evidence:

- OpenCode documents `opencode acp` for ACP-compatible editors.
- The command communicates with editors through JSON-RPC over stdio.
- Local `opencode acp --help` confirms ACP server support and accepts `--cwd`.

Nucleus should treat ACP as:

- a compatibility adapter path for ACP-native clients
- a fallback if server/SDK gaps appear
- a comparison source for event identity

Do not collapse OpenCode server/SDK and OpenCode ACP into one false transport
model. They are two adapter transports for one harness.

## Session And Event Identity

OpenCode server sessions provide a provider session id.

Nucleus must retain:

- nucleus session id
- adapter instance id
- OpenCode session id
- message id
- message part id
- tool call id where supplied
- permission request id
- question request id
- event type and provider-native event payload

T3 uses OpenCode message part ids as runtime item ids and maps active turns to
nucleus turn ids. It also records provider-native events with provider session
id and nucleus thread id.

OpenCode event ids are not the primary identity surface in T3. Nucleus should
generate nucleus event ids while preserving provider-native ids and raw event
payloads.

## Lifecycle Mapping

First-pass lifecycle:

- `Create`: connect to or spawn server, create SDK client, create OpenCode
  session
- `SendTurn`: `session.promptAsync`
- `Steer`: send a second prompt while a session is busy and reuse the active
  turn id
- `Cancel` / `Interrupt`: `session.abort`
- `Read`: list session messages and parts
- `Rollback`: `session.revert`, then read messages
- `RespondToApproval`: `permission.reply`
- `RespondToUserInput`: `question.reply`
- `Close`: abort session, close event stream, close owned server scope

OpenCode supports session fork and diff. These should be explicit capabilities,
not hidden inside rollback.

## Permissions And Questions

OpenCode has permission rules and runtime permission events.

The adapter must preserve:

- permission id
- permission kind
- pattern list
- metadata
- reply value

OpenCode permissions include `read`, `edit`, `bash`, `task`, `skill`, `lsp`,
`question`, `webfetch`, `websearch`, `external_directory`, and `doom_loop`.

Questions are a separate user-input channel. T3 maps OpenCode
`question.asked`, `question.replied`, and `question.rejected` to canonical
user-input events. Nucleus should keep the same separation.

## Model And Provider Routing

OpenCode model selections use `provider/model`.

Nucleus must keep:

- OpenCode adapter instance id
- OpenCode provider id
- OpenCode model id
- agent option where supplied
- variant/reasoning option where supplied

OpenCode Zen and OpenRouter are OpenCode provider/model routes. They are not
separate harness adapters unless used through a different harness runtime.

T3 tests show why this matters: model selections are rejected when they are
bound to a different OpenCode instance id.

## Local Binary Notes

Local OpenCode evidence:

- `opencode --version`: `1.14.48`
- `opencode serve --help`: starts a headless server and exposes hostname,
  port, mDNS, and CORS controls
- `opencode acp --help`: starts an ACP server and accepts `--cwd`

## Promotion

Promoted into:

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/004-model-routing-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/architecture/system-architecture.md`

## Remaining Gaps

- Verify current SDK event schema from generated OpenCode types before Rust
  implementation.
- Decide whether the SDK sidecar should be long-lived per adapter instance or
  scoped per session.
- Decide whether nucleus should support OpenCode ACP as a second adapter
  implementation in the first provider batch.
- Define credential storage for external server Basic auth and provider keys.
- Define how OpenCode fork, share, diff, revert, and unrevert should appear in
  canonical capabilities.

## Next Task

Draft task-level agent assignment and model preference semantics.
