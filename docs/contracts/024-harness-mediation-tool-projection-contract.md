# 024 Harness Mediation And Tool Projection Contract

Status: draft
Owner: Tom
Updated: 2026-06-19

## Purpose

Define how Nucleus can add project-aware tools and steering around bridged
harness chats without pretending every vendor harness supports the same
extension model.

Nucleus owns a canonical tool and mediation model. Each harness adapter declares
which projection modes it can support.

## Mediation Rule

Nucleus may mediate a bridged harness conversation through:

- structured provider APIs where available
- ACP or equivalent tool/session surfaces where available
- SDK sidecars where provider policy allows them
- CLI/PTY observation and prompt steering when no structured tool surface exists
- Nucleus-owned sidecar execution with summarized evidence fed back into the
  chat
- native steward or helper agents that work beside the bridged harness

Mediation must preserve provider identity, user intent, task authority,
command policy, evidence retention, and audit boundaries.

Mediation must not silently impersonate provider-native tools, falsify harness
capabilities, hide provider limitations, or copy raw provider material into
Nucleus state.

## Tool Projection Rule

Nucleus tools are canonical capabilities first. Harness-specific exposure is a
projection.

Projection modes:

- native harness tool registration
- MCP or tool-server registration
- ACP tool capability
- SDK-sidecar callable
- prompt/skill instruction surface
- Nucleus sidecar execution with summarized results
- unavailable

Adapters must report supported projection modes per tool family. Unsupported
projection modes must be visible.

## Tool Cardinality Rule

Nucleus should avoid overloading agents with large flat tool menus.

Prefer portal tools with typed actions over many narrow tools when the domain
has one coherent command surface.

Effigy is the model case:

- expose one canonical `Effigy` tool family
- publish supported actions such as selector inventory, doctor summary,
  validation plan, selector execution request, repair hint synthesis, and
  manifest proposal
- keep action schemas discoverable by the agent
- route all command execution through host command authority
- keep raw command output behind receipt/artifact policy

This is analogous to shell access being one tool with many commands, but with
stronger action metadata because models are not assumed to know Effigy.

If a harness cannot expose a dynamic action catalogue, Nucleus should project a
small stable portal plus concise instructions or use sidecar execution.

## Effigy Portal Tool Rule

Effigy must not become a large bundle of unrelated top-level tools.

The first Nucleus-owned Effigy portal should model:

- `list_selectors`
- `doctor_summary`
- `test_plan_summary`
- `run_selector_request`
- `repair_hints`
- `manifest_change_proposal`

Action availability depends on project opt-in, host command authority, selector
scope, command-scope hints, sandbox readiness, and approval policy.

Effigy portal actions may produce:

- runtime receipt refs
- sanitized command evidence refs
- selector refs
- health summaries
- validation-plan summaries
- repair hints
- steward proposal refs

They must not produce raw command output, secrets, credentials, unbounded local
paths, release mutations, or direct project/task mutations.

## Steering Rule

Nucleus may proactively steer conversations by adding context, summaries,
repair hints, next-task pointers, validation expectations, or task state.

Steering is not command authority.

A steering intervention must identify:

- source: system policy, task state, goal loop, steward, Effigy evidence,
  memory, planning artifact, or operator instruction
- target harness/session/thread where known
- intended effect: orient, warn, ask, suggest, block, summarize, or hand off
- authority status: advisory, operator-confirmed, or policy-blocking
- evidence refs

Steering must not silently mutate task state, answer provider callbacks,
cancel provider work, resume provider sessions, or perform tool execution.

## Visibility Rule

Visible work forks are preferred for meaningful subagent work.

Nucleus may support:

- visible forks: child work items, child agent threads, or research/planning
  runs with their own receipts and review path
- private helpers: bounded summarization, classification, or evidence
  extraction with receipt-backed audit

Private helpers must stay bounded. They must not hide material decisions,
produce accepted task results, or mutate shared state without an admitted
command.

## Capability Records

Each harness adapter should eventually expose:

- supported tool projection modes
- dynamic action catalogue support
- prompt/skill injection support
- sidecar execution support
- steering message support
- context refresh support
- permission/callback response support
- cancellation/resume support
- terminal fallback support
- native browser/tool support if any

These capabilities are not uniform. The UI and steward should show when a
provider is operating through a weaker projection mode.

## Out Of Scope

- Implementing Effigy portal actions.
- Defining every Nucleus tool family.
- Replacing provider-native tools.
- Bypassing provider policy or authentication.
- Forcing CLI-only harnesses to behave like structured tool runtimes.

## Research Gaps

- Which harnesses support dynamic tool/action catalogues cleanly.
- Whether ACP tool metadata can represent portal-style action catalogues well
  enough for Effigy.
- How Codex app-server, Claude SDK, Cursor ACP, OpenCode server, Pi RPC, and
  Kimi ACP differ in tool projection support.
- Whether portal tools should have a shared schema format across bridged and
  native harnesses.
