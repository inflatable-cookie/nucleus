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
- Pi is a useful reference for embeddability: its RPC docs describe headless
  JSON over stdio, and its SDK docs describe embedding agent capabilities in
  custom UIs and automation.
- Rig is a credible Rust candidate for modular LLM application and agent
  abstractions.
- Candle is a credible Rust-native local inference building block, but it is
  an inference framework, not an agent runtime by itself.
- OpenClaw's documented split between built-in agent runtime, model/provider
  helpers, and plugin-facing contracts is relevant to Nucleus native harness
  boundaries.

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

## Promotion Targets

- `docs/specs/003-nucleus-native-harness-and-steward-runtime.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/architecture/system-architecture.md`

## Next Task

Research Nucleus native harness and steward runtime semantics.
