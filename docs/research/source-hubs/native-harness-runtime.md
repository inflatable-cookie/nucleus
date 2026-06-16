# Native Harness Runtime Source Hub

Status: open
Owner: Tom
Updated: 2026-06-16

## Purpose

Collect evidence for Nucleus-owned harnesses, steward personas, and Rust-native
agent/runtime building blocks.

## Sources

- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode SDK docs: `https://opencode.ai/docs/sdk/`
- OpenCode plugins docs: `https://opencode.ai/docs/plugins/`
- Pi docs: `https://pi.dev/`
- Pi SDK docs:
  `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md`
- Pi RPC docs:
  `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md`
- Rig docs: `https://rig.rs/`
- Rig source: `https://github.com/0xPlaygrounds/rig`
- Candle source: `https://github.com/huggingface/candle`
- OpenClaw agent runtime notes:
  `https://docs.openclaw.ai/agent-runtime-architecture`

## Initial Findings

- OpenCode is a useful reference for server/client separation: its docs
  describe a TUI client talking to a local server, with OpenAPI and SDK
  surfaces for programmatic control.
- OpenCode's server surface is broad: project, path/VCS, config, provider,
  session, message, command, file, tool, LSP/MCP, agent, TUI, auth, and event
  APIs. Nucleus should borrow the separation pattern, not the exact domain
  shape.
- OpenCode's plugin docs are a useful event-hook reference. For Nucleus native
  harnesses, plugin-like extension points should remain policy-bound and
  should not bypass server authority.
- Pi is a useful reference for embeddability: its RPC docs describe headless
  JSON over stdio, and its SDK docs describe embedding agent capabilities in
  custom UIs and automation.
- Pi's RPC mode is a strong reference for a language-neutral native-harness
  boundary: command ids, request/response over stdio, streamed events, and
  headless operation. Nucleus can borrow the boundary shape without making Pi
  the native runtime.
- Pi's SDK shape is useful for rich app embedding, but it likely implies a
  sidecar or non-Rust runtime if reused directly.
- Rig is a credible Rust candidate for modular LLM application and agent
  abstractions.
- Rig should be evaluated as an orchestration/helper layer, not accepted as the
  core Nucleus agent runtime before its fit with Nucleus state, tools, and
  permissions is proven.
- Candle is a credible Rust-native local inference building block, but it is
  an inference framework, not an agent runtime by itself. It belongs under a
  model backend abstraction.
- OpenClaw's documented split between built-in agent runtime, model/provider
  helpers, and plugin-facing contracts is relevant to Nucleus native harness
  boundaries.

## First-Pass Direction

Native harnesses should start with Rust-owned orchestration.

The initial native runtime should not embed Pi as its core. Pi remains a
bridged harness candidate and an architecture reference. A sidecar remains
possible for model backends or specific borrowed runtimes, but Nucleus domain
state, policies, tools, and audit should stay Rust-owned.

First implementation target after contracts settle:

- project steward persona
- deterministic tool layer for task/project/sync inspection
- model backend abstraction
- local cheap model path where possible
- approval-gated sync actions
- Nucleus-native session and event records

## Candidate Backend Roles

| Candidate | Possible role | Risk |
| --- | --- | --- |
| Rust-owned runtime | Native authority and tool orchestration. | More design work upfront. |
| Pi RPC | Bridged harness or reference for headless event protocol. | Not Rust-owned; may pull native state through an external runtime. |
| Pi SDK | Rich embedding reference or sidecar path. | Tighter coupling to non-Rust runtime. |
| Rig | Model/agent helper layer inside Rust runtime. | May not match Nucleus domain policy model. |
| Candle | Local inference backend candidate. | Inference only; no agent runtime. |
| Ollama/llama.cpp/mistral.rs | Pragmatic local model backend candidates. | Backend-specific deployment and model packaging tradeoffs. |

## Research Questions

- Which parts of Pi's architecture are worth borrowing for a Nucleus-native
  runtime?
- Should Nucleus embed Pi, bridge Pi, or only use it as a reference?
- Does Rig provide useful abstractions without constraining Nucleus domain
  state too much?
- Which local-model backend should be explored first for steward tasks?
- How should native personas expose capabilities and approval gates?
- How should native harness event identity differ from bridged harness event
  identity?
- What is the minimal native session record before provider-agnostic runtime
  events are reused?
- Which project steward actions are deterministic and should never call a
  model?

## Promotion Targets

- `docs/specs/003-nucleus-native-harness-and-steward-runtime.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/architecture/system-architecture.md`

## Next Task

Draft runtime effect trait boundary.
