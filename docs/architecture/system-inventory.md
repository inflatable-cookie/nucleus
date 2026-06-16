# System Inventory

Status: draft
Owner: Tom
Updated: 2026-06-16

## Repos

- `nucleus`: current repo, docs authority and future Rust workspace.
- `external/t3code`: ignored research clone, not vendored product code.

## Rust Crates

- `nucleus-core`: first draft persistence domains, record identity, revision,
  snapshot, journal, projection envelope vocabulary, and storage-boundary
  contract docs. Runtime effect storage is documented as server-owned
  normalized event and ref storage, but no Rust storage types or persistence
  implementation exist yet.
- `nucleus-agent-protocol`: first draft adapter identity, transport,
  capability, event identity, model-route, and agent session lifecycle types.
- `nucleus-agent-adapters`: first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- `nucleus-native-harness`: first draft Nucleus-owned persona, session, event,
  tool, approval, model backend, and audit boundary types.
- `nucleus-command-policy`: first draft command authority, sandbox, approval,
  and sanitized command evidence boundary types. Current contracts define the
  first production command authority trait boundary in docs, with
  a static policy-inspection trait skeleton now present. Runtime command
  effects are documented and have type-only request/outcome vocabulary.
  Runtime command effect trait responsibilities are drafted in docs, with
  value-shaped request-acceptance and outcome-reporting trait skeletons now
  present. Runtime command effect state-machine policy is documented, but no
  scheduler exists. Value-shaped command runtime effect state types now name
  non-terminal states, terminal states, state records, and optional retry
  classification. Runtime command effect event vocabulary is documented, with
  compile-only command event payload types now present. No event transport,
  persistence, replay, or subscriptions exist. Runtime effect replay and
  retention policy is documented, but no Rust replay or retention policy types
  exist.
- `nucleus-contract-fixtures`: dev-only, unpublished contract fixture
  vocabulary crate for provider-neutral SCM/forge and command-policy contract
  tests. Production crates must not depend on it. The first integration tests
  prove provider-neutral workflow, command-policy, sanitized-evidence,
  task-link, conflict, and review vocabulary without live providers. It also
  contains deterministic fake adapter skeletons for command-policy, SCM, and
  forge test surfaces plus ordered scenario scripts for management-state sync
  and blocked-policy / rejected-review paths.
- `nucleus-projects`: first draft durable project, repo membership, path
  history, repair action, activity, and projection record types.
- `nucleus-scm-forge`: first draft provider-agnostic SCM, forge, credential,
  webhook, conflict, review-workflow, task-link, observation, and work-session
  boundary types. Current contracts define the first production adapter trait
  boundary in docs, with static SCM, forge, and observation-source trait
  skeletons now present. Runtime SCM/forge effects are documented and have
  type-only request/outcome vocabulary. Runtime SCM/forge effect trait
  responsibilities are drafted in docs, with value-shaped SCM and forge
  request-acceptance and outcome-reporting trait skeletons now present.
  Runtime SCM/forge effect state-machine policy is documented, but no scheduler
  exists. Value-shaped adapter runtime effect state types now name
  non-terminal states, terminal states, state records, and optional retry
  classification. Runtime adapter effect event vocabulary is documented, with
  compile-only adapter event payload types now present. No event transport,
  persistence, replay, or subscriptions exist. Adapter replay and retention
  policy is documented, but no Rust replay or retention policy types exist.
- `nucleus-tasks`: first draft task identity, importance, neglect, action,
  assignment, activity, agent-readiness, and projection record types.
- `nucleus-workspaces`: first draft modular workspace layout, panel, and
  surface types.
- `nucleus-server`: first draft modular server authority, deployment, client,
  command, and event boundary types. Runtime effect server event envelope types
  are compile-only and do not implement transport, persistence, replay,
  subscriptions, scheduling, or runtime execution. Runtime effect replay and
  retention policy types are compile-only and do not implement storage, replay
  APIs, event transport, artifact stores, subscriptions, scheduling, or runtime
  execution. Runtime effect storage boundaries are documented, but no storage
  refs, checkpoints, replay indexes, persistence backend, or replay API exist.
  Runtime effect storage boundary types now name retained event records,
  storage refs, replay checkpoints, stored effect states, and query postures,
  but they do not implement persistence, serialization, replay APIs, event
  transport, subscriptions, artifact stores, scheduling, command execution, or
  adapter execution. Runtime effect replay query types now name client ordering
  tokens, storage generation posture, query requests, responses, result items,
  status, unsupported reasons, and ref-resolution states, but they do not
  implement replay, persistence, transport, subscriptions, artifact storage,
  client caching, scheduling, command execution, or adapter execution. Runtime
  effect subscription types now name subscription ids, handshakes, lifecycle
  states, acknowledgement posture, backpressure posture, disconnect reasons,
  and reconnect requirements, but they do not implement transport, event bus,
  replay service, persistence, acknowledgement processing, client caching,
  scheduling, command execution, or adapter execution.

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
