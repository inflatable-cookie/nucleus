# 003 Nucleus Native Harness And Steward Runtime

Status: active
Owner: Tom
Updated: 2026-06-16

## Purpose

Shape the app-owned harness lane before Nucleus treats every agent as an
external bridged provider.

Nucleus should support bridged harnesses and native Nucleus-owned harnesses.
Bridged harnesses preserve provider behavior behind adapters. Native harnesses
are built for Nucleus roles that need direct access to project, task, sync,
docs, and validation state.

## Working Position

Use two harness families:

- bridged harnesses: Codex, Claude, Cursor, OpenCode, Kimi, Pi, and similar
  external runtimes
- native harnesses: Nucleus-owned agent runtimes for stewardship,
  organization, validation summarization, project docs, and sync assistance

The project steward is the first native harness persona.

## External Structure Signals

OpenCode is useful as a server/client reference. Its docs describe a TUI that
talks to a local server, an OpenAPI spec, and generated SDKs for programmatic
control.

Pi is useful as an embeddable harness reference. Its RPC docs describe
headless JSON over stdin/stdout, and its SDK docs describe programmatic access
for custom UIs, automation, and sub-agent workflows.

Rust ecosystem candidates:

- Rig: Rust library for modular LLM-powered applications and agents.
- Candle: Rust ML framework for local inference and GPU/CPU execution.
- llama.cpp bindings or Ollama clients: pragmatic local-model backend options.
- Pi itself: possible bridged or embedded harness for some personas.

## Native Harness Roles

Initial native personas:

- project steward
- task triage assistant
- documentation maintainer
- sync conflict assistant
- validation summarizer
- research librarian
- lightweight local helper

These personas should share one native runtime boundary but have separate
capabilities, policies, and scopes.

## Steward Responsibilities

The project steward may:

- normalize task metadata
- detect stale, duplicate, blocked, or conflicting tasks
- prepare management-state commits
- reconcile mechanical Git conflicts
- summarize task history and validation evidence
- update project docs and indexes
- link tasks to commits, branches, pull requests, issues, and artifacts
- ask for human decisions on semantic conflicts

It must not silently:

- delete tasks
- rewrite meaningful task history
- push code changes
- resolve semantic disagreements
- expose secrets
- change provider auth or runtime state

## Runtime Boundary

The native harness runtime should be Nucleus-owned.

It may use:

- deterministic tools first
- model calls for classification, summarization, merge suggestions, and
  ambiguity handling
- local cheap models where sufficient
- cloud models only under explicit policy

It should expose session, event, tool, approval, and audit records through the
same broad Nucleus concepts used by bridged harnesses, while remaining clearly
identified as app-owned.

## Open Questions

- Should the first native harness be pure Rust or Rust orchestration with a
  sidecar model/runtime?
- Should Pi be embedded, bridged, or only used as a reference?
- Which local inference backend should be explored first?
- How should persona capability scopes be represented?
- Which steward actions can be automatic under policy?
- How should native harness events differ from bridged provider events?
- What is the minimum deterministic tool layer before any model call?

## Promotion Targets

- `docs/architecture/system-architecture.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- new native harness runtime contract
- future Rust crate or module for native harness runtime

## Next Task

Research Nucleus native harness and steward runtime semantics.
