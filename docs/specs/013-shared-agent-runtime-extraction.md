# 013 Shared Agent Runtime Extraction

Status: promoted migration evidence
Owner: Tom
Updated: 2026-07-19

## Purpose

Shape a reusable Rust foundation for discovering, connecting to, and driving
AI models and agent harnesses without making Nucleus the upstream owner of
general-purpose integration code.

The same foundation should serve:

- Nucleus: persistent interactive sessions, tools, interruption, and resume
- Soundcheck: bounded structured runs with progress, cancellation, and schemas
- future applications: CLI, API, SDK, local-model, and remote-agent adapters

This spec is now Nucleus-side migration evidence. Contract 030 and roadmap 049
govern downstream adoption. Swallowtail owns the shared
vision, architecture, contracts, and implementation roadmap in its dedicated
repository.

## Project Identity

The shared runtime is **Swallowtail**.

Repository identity:

- local checkout: `~/Dev/projects/swallowtail`
- GitHub: `inflatable-cookie/swallowtail`
- remote: `git@github.com:inflatable-cookie/swallowtail.git`

Package naming:

- shared types and capability vocabulary: `swallowtail-core`
- execution and supervision: `swallowtail-runtime`
- Codex integration: `swallowtail-codex`
- adapter conformance fixtures: `swallowtail-testkit`

`Swallowtail` is a product identity, not a claim that the library owns an
agent's decision loop. The architecture must continue to distinguish host
applications, agent harnesses, direct model routes, and transports.

## Working Position

The dedicated-repository decision is accepted. Do not place this code inside
Monkey by default.

Monkey currently owns generalized ML execution, artifacts, training, and
local-model runtime concerns. Swallowtail should own application-to-model and
application-to-agent connectivity. Monkey may implement a local model route
consumed through Swallowtail. That produces a useful family of AI systems
without forcing one repository to own two different architectural centres.

Moving Swallowtail into Monkey remains possible, but only after an explicit
Monkey vision and package-authority reset. It is not an extraction shortcut.

## Evidence From Current Consumers

Nucleus already contains the beginning of the shared seam:

- `nucleus-agent-protocol::live_runtime` defines provider-neutral session,
  turn, tool-call, model-catalog, and runtime traits
- `nucleus-agent-adapters` owns discovery, descriptors, a live registry, and a
  Codex app-server runtime
- `nucleus-server::local_codex_chat` consumes the runtime trait while retaining
  task tools, mandates, persistence, and receipts

The seam is not ready to move wholesale:

- `nucleus-agent-protocol` also contains Nucleus-owned identities, events,
  lifecycle policy, and Codex fixture records
- Nucleus still has Codex-specific supervision and task execution paths outside
  the newer live adapter
- the live traits expose one blocking interactive shape and string errors
- process launching, credentials, progress, cancellation, timeouts, structured
  output, and attachments do not yet form shared host ports

Soundcheck independently implements the missing bounded-run shape:

- Codex executable discovery, version probing, and login readiness
- `codex exec --json --ephemeral`
- model and reasoning selection
- JSON Schema output
- progress decoding, timeout, cancellation, and stderr diagnostics
- product-owned validation and repair passes

The duplication proves a common foundation is useful. The different execution
shapes prove that a single `send_prompt` facade would be too weak.

## Boundary

Swallowtail owns mechanisms. Consumer applications own intent, authority, and
durable product state.

| Concern | Swallowtail | Consumer application |
| --- | --- | --- |
| Adapter identity and capabilities | owns | selects under policy |
| Executable, API, and SDK discovery | owns | supplies configuration and host ports |
| Version, auth, and readiness probes | owns normalized results | owns credential UX and secret storage |
| Model catalogs and model routes | owns transport-neutral vocabulary | owns defaults, budgets, and availability policy |
| Process and transport drivers | owns | chooses execution host |
| Persistent sessions and bounded runs | owns lifecycle mechanism | owns why and when they run |
| Streaming events, cancellation, timeout, resume | owns normalized mechanism | owns product consequences |
| Structured output and attachments | owns transport shape | owns schemas and domain validation |
| Tools | carries declarations and calls | owns implementation, authority, and receipts |
| Conversations, goals, tasks, memory | does not own | owns |
| Scheduling, approval, and audit policy | does not own | owns |
| Product-specific repair loops | does not own | owns |

## System Shape

Do not flatten models and agent harnesses into one interface.

```text
Nucleus       Soundcheck       future hosts
    \             |                /
        Swallowtail host API
          /              \
  agent harnesses       model routes
  sessions + tools      bounded inference
          \              /
       process / API / SDK transports
                    |
        Codex, Claude, local runtimes, ...
```

Three layers:

1. **Core**: identities, capabilities, configuration, normalized errors,
   events, model catalogs, tool calls, structured-output descriptors
2. **Runtime**: discovery, readiness, process supervision, cancellation,
   timeout, transport, and execution lifecycle
3. **Adapters**: provider- and harness-specific protocol translation

Host integration should be port-based. The shared runtime must not assume that
the desktop client is the execution host, that credentials live in the client,
or that a working directory is locally accessible.

## Execution Shapes

Expose two capability-driven operations from the start.

### Interactive Session

For chat and agent work which may span several turns:

- start or resume a session
- stream normalized progress and provider events
- send turns
- surface tool calls to the host
- interrupt and close
- retain provider-native opaque references for resume

### Structured Run

For bounded product work such as Soundcheck tagging:

- one request with prompt, inputs, attachments, model route, and optional schema
- streamed progress
- explicit timeout and cancellation
- typed completion with structured output and usage where available
- provider diagnostics with secrets and raw payloads controlled by host policy

Adapters declare capabilities. Hosts must be able to reject unsupported
combinations before starting execution.

## Initial Repository Shape

The initial target has four crates. The first implementation batch creates only
`swallowtail-core` and `swallowtail-testkit`; runtime and Codex crates follow
after the portable records and conformance rules settle. Split further only
after a second adapter proves the need.

### `swallowtail-core`

- stable ids and opaque provider references
- model and reasoning options
- adapter capability manifest
- session, run, tool-call, attachment, event, and outcome types
- normalized error taxonomy
- no Tokio, process spawning, persistence, or consumer domain types

### `swallowtail-runtime`

- adapter registry
- host ports for process spawning, time, cancellation, credentials, and events
- interactive-session and structured-run traits
- lifecycle coordination and redaction hooks
- no Nucleus task concepts or Soundcheck taxonomy concepts

### `swallowtail-codex`

- Codex CLI discovery and readiness
- model catalog
- app-server interactive session driver
- exec structured-run driver
- Codex wire/event translation
- no product prompts, tools, schemas, or repair policy

### `swallowtail-testkit`

- scripted transport and process fixtures
- adapter capability conformance suite
- redaction and cancellation assertions
- stable provider-event fixtures where licensing permits

## First Implementation Boundary

The first Swallowtail implementation batch is a provider-neutral contract
kernel. It must not start a real process, call a provider, or change either
consumer's dependencies.

Deliver in Swallowtail:

1. Northstar vision, architecture, contract, roadmap, and log front doors
2. a Rust workspace containing `swallowtail-core` and `swallowtail-testkit`
3. pure records for adapter identity, capability manifests, model catalogs,
   opaque provider references, normalized safe errors, and normalized event
   envelopes
4. fixture-driven conformance checks for capability rejection, provider-ref
   opacity, safe diagnostics, and provider-extension isolation

Do not copy a Nucleus module wholesale. Re-author the small portable records
against Swallowtail contracts so existing product assumptions become explicit
move-or-stay decisions.

Initial source decisions:

| Existing source | First-batch decision | Reason |
| --- | --- | --- |
| `nucleus-agent-protocol/src/live_runtime.rs` | reference and reshape | Contains the clearest shared seam, but blocking traits, raw strings, JSON tool declarations, local paths, and string errors are not portable contracts. |
| `nucleus-agent-protocol/src/{identity,capabilities,routes,events}.rs` | selectively reference | Useful vocabulary is mixed with Nucleus lifecycle, routing policy, and raw-provider retention assumptions. |
| `nucleus-agent-adapters/src/{codex_runtime,live_registry}.rs` | split at the facade | Codex process, JSON-RPC, timeout, callbacks, and cleanup moved to Swallowtail; Nucleus keeps its registry and product-facing `AgentSessionRuntime` bridge. |
| `nucleus-server/src/local_codex_chat/**` | stay downstream | Prompts, task portals, mandates, persistence, receipts, review context, and product reply shapes are Nucleus policy. |
| `soundcheck/src-tauri/src/{app_settings,assistant_tagging}.rs` | stay in Soundcheck | Discovery and execution contain reusable mechanisms, but prompts, taxonomy schemas, validation, repair, progress wording, and product cancellation consequences are still interleaved. |

Explicitly excluded from the first batch:

- interactive-session and structured-run execution traits
- async-runtime selection
- process, API, SDK, credential, filesystem, clock, and cancellation ports
- Codex wire formats, app-server, or `codex exec`
- product prompts, tool implementations, schemas, validation, repair, storage,
  receipts, tasks, goals, memory, or UI
- Nucleus or Soundcheck dependency changes and deletion of existing code

The first batch is complete when both consumers can review the shared records
without importing them, fixture tests prove the portable invariants, and the
next batch can define execution traits without reopening repository ownership.

## Migration Plan

### Stage 0: establish authority

- completed 2026-07-19
- Swallowtail name and dedicated-repository decision settled
- strict Northstar authority surfaces and g01 roadmap created upstream
- cross-repository ownership recorded upstream
- portable contract kernel settled before runtime behavior moves

### Stage 1: prove the shared core

- re-author the portable records using `nucleus-agent-protocol` as evidence
- define both execution shapes and capability negotiation after the first
  contract-kernel batch
- replace string errors and implicit local paths with typed host-facing records
- build the testkit before moving the live Codex implementation

No Nucleus dependency changes in this stage.

### Stage 2: move Codex mechanisms

- adapt the Nucleus Codex app-server implementation into
  `swallowtail-codex`
- adapt Soundcheck's Codex exec implementation into the bounded-run driver
- consolidate discovery, readiness, model listing, progress, cancellation,
  timeout, and diagnostics
- retain product prompts, tools, validation, and repair loops downstream

### Stage 3: adopt in Soundcheck first

Soundcheck is the smaller consumer and the cleanest proof of a portable API.

- replace direct Codex discovery, model listing, and exec supervision
- preserve current tagging behavior and progress UX
- prove that Soundcheck contains no Swallowtail-internal policy

### Stage 4: adopt in Nucleus

- replace the newer live adapter and registry with Swallowtail dependencies
- route remaining Codex-specific execution toward the shared adapter in bounded
  batches
- keep Nucleus session persistence, mandates, tool portals, task linkage,
  authority, receipts, and UI unchanged
- delete superseded generic code only after parity is proven

### Stage 5: prove extension

- add one materially different adapter or model route
- use that work to decide whether crate splitting or API changes are justified
- consider a Monkey local-model route without moving Monkey's runtime authority

## Compatibility And Distribution

- remain pre-1.0 during extraction
- prefer direct migration over compatibility shims
- sibling path dependencies are valid during local multi-repo development;
  pin versions or revisions when the consumers enter versioned distribution
- publish crates only after both consumers exercise the intended public API
- version provider adapters independently where provider protocols demand it
- never expose provider wire payloads as the stable cross-provider API

## Stop Conditions

- extraction requires moving Nucleus task, goal, memory, project, or authority
  concepts upstream
- the shared API collapses interactive sessions and bounded runs into one weak
  prompt call
- a provider-specific payload becomes the common contract
- the runtime assumes execution happens on the UI client
- Soundcheck must adopt Nucleus conversation or persistence concepts
- Monkey's current architecture is broadened without an explicit authority
  decision
- Nucleus is switched in one big-bang migration

## Settled Decisions

- project name: `Swallowtail`
- dedicated repository rather than a Monkey package family
- initial repository host and namespace: `inflatable-cookie/swallowtail`

## Decisions Needed

- decide whether the first public API is async-only
- settle the minimum normalized event and error vocabularies
- settle host ownership of credential lookup, process spawning, and redaction
- decide whether schema validation itself belongs in core or stays downstream
- define the first two-consumer conformance matrix

## Acceptance Criteria

This spec can close when:

- repository ownership and dependency direction are unambiguous
- interactive-session and structured-run contracts are promotable
- generic Nucleus and Soundcheck source inventories have move/stay decisions
- Monkey's relationship is recorded without changing its authority by accident
- migration stages preserve working product behavior at every boundary
- the new repository can compile a roadmap without depending on this spec as
  permanent architecture

## Promotion Targets

After operator acceptance, promote into the new repository:

- `docs/vision/README.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/package-map.md`
- `docs/architecture/repository-authority-map.md`
- adapter, runtime, host-port, event, error, and security contracts
- an extraction/adoption roadmap

Then update Nucleus, Soundcheck, and Monkey authority maps with dependency
direction. Keep this spec only as planning history until those surfaces carry
the durable truth.
