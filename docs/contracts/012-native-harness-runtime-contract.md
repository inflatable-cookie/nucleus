# 012 Native Harness Runtime Contract

Status: draft
Owner: Tom
Updated: 2026-06-16
Spec refs: `docs/specs/003-nucleus-native-harness-and-steward-runtime.md`

## Purpose

Define the first boundary for Nucleus-owned harnesses and steward personas.

Native harnesses are app-owned runtimes. They are not external provider
bridges, even when they call local or cloud models internally.

## Harness Families

Nucleus has two harness families:

- bridged harnesses: external provider runtimes reached through adapters
- native harnesses: Nucleus-owned runtimes built for project management,
  stewardship, docs, validation, and sync work

Both families should expose compatible session, event, capability, and audit
concepts where useful. They must not hide their ownership differences.

## Native Runtime Boundary

The native runtime may include:

- deterministic planning and sync tools
- model backend abstraction
- local model backend
- cloud model backend under policy
- persona capability scopes
- approval gates for privileged actions
- audit records for proposed and completed actions

The native runtime must not pretend to be a provider CLI. It can use the
Nucleus server API and internal domain services directly under explicit
capability policy.

## Initial Personas

Initial native personas:

- project steward
- task triage assistant
- documentation maintainer
- sync conflict assistant
- validation summarizer
- research librarian
- lightweight local helper

The project steward is the first implementation target once the native harness
lane is promoted.

## Steward Authority

The steward may prepare or propose:

- task metadata normalization
- management-state commits
- mechanical sync conflict resolutions
- documentation index updates
- task history summaries
- forge links
- validation summaries

The steward must ask for approval before:

- pushing under assisted policy
- resolving semantic conflicts
- rewriting meaningful task history
- deleting tasks
- changing sync policy

The steward must not:

- push code changes under management-sync authority
- expose secrets
- mutate provider auth state
- bypass task or sync policy

## Model Backend Rule

Native harness personas should use deterministic tools before model calls.

Model backends are implementation choices. Initial candidates include local
models through a local inference server, Rust inference libraries, or cloud
model routes under explicit policy.

Small local models are preferred for cheap classification, triage, hygiene,
and summarization when quality is sufficient.

## Current Rust Surface

No Rust surface exists yet.

This contract should eventually inform a native harness crate or module
boundary, but implementation is out of scope until the persona and runtime
contracts settle.

## Research Gaps

- Pure Rust runtime versus sidecar runtime.
- Rig suitability for Nucleus-native agents.
- Candle, llama.cpp, Ollama, and mistral.rs backend tradeoffs.
- Pi as embedded runtime versus bridged external harness.
- Event identity for native harness sessions.
- Persona capability and approval policy model.

## Next Task

Research Nucleus native harness and steward runtime semantics.
