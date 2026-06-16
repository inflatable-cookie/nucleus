# System Inventory

Status: draft
Owner: Tom
Updated: 2026-06-15

## Repos

- `nucleus`: current repo, docs authority and future Rust workspace.
- `external/t3code`: ignored research clone, not vendored product code.

## Rust Crates

- `nucleus-core`: first draft persistence domains, record identity, revision,
  snapshot, and journal vocabulary.
- `nucleus-agent-protocol`: first draft adapter identity, transport,
  capability, event identity, model-route, and agent session lifecycle types.
- `nucleus-agent-adapters`: first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- `nucleus-native-harness`: first draft Nucleus-owned persona, session, event,
  tool, approval, model backend, and audit boundary types.
- `nucleus-projects`: first draft durable project, repo membership, path
  history, repair action, and activity types.
- `nucleus-tasks`: first draft task identity, importance, neglect, action,
  assignment, activity, and agent-readiness types.
- `nucleus-workspaces`: first draft modular workspace layout, panel, and
  surface types.
- `nucleus-server`: first draft modular server authority, deployment, client,
  command, and event boundary types.

## Apps

- `apps/nucleusd`: future server binary placeholder.
- `apps/desktop`: future Tauri client placeholder.

## External Systems To Research

- T3 Code
- Agent Client Protocol
- Codex CLI
- Claude Code
- Cursor SDK and CLI
- OpenCode ACP
- Kimi CLI and Kimi Agent SDK
- Pi
- GLM/Z.ai
- MiniMax
- DeepSeek
- OpenRouter
- OpenCode Zen

## T3 Code Provider Integration Paths

- Provider adapter contract:
  `external/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`
- Runtime event contract:
  `external/t3code/packages/contracts/src/providerRuntime.ts`
- Provider instance identity:
  `external/t3code/packages/contracts/src/providerInstance.ts`
- Codex adapter:
  `external/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
- Claude adapter:
  `external/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Cursor adapter:
  `external/t3code/apps/server/src/provider/Layers/CursorAdapter.ts`
- OpenCode adapter:
  `external/t3code/apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- ACP runtime:
  `external/t3code/apps/server/src/provider/acp/AcpSessionRuntime.ts`
- OpenCode runtime:
  `external/t3code/apps/server/src/provider/opencodeRuntime.ts`
- Remote architecture:
  `external/t3code/docs/architecture/remote.md`

## Next Task

Draft projection storage Rust surface boundaries.
