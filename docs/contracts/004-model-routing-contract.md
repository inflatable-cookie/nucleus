# 004 Model Routing Contract

Status: draft
Owner: Tom
Updated: 2026-06-15

## Purpose

Define the model/provider routing layer that sits below harness adapters.

Harness adapters own sessions, tools, approvals, events, and process/runtime
lifecycle. Model routes describe which inference backend a harness or future
native model client uses.

## Boundary

Model routes are not harness adapters.

A route does not create a nucleus agent session by itself unless paired with a
harness/runtime that provides:

- session lifecycle
- tool execution boundary
- approval flow
- event stream
- message identity
- cancellation/recovery behavior

## Route Identity

Each route must expose:

- route id
- provider id
- display name
- API compatibility family
- base URL or provider endpoint id
- model id
- auth source
- billing/account source
- enabled state

API compatibility family values:

- OpenAI-compatible
- Anthropic-compatible
- provider-native
- gateway/router

## Capability Metadata

Routes must expose best-known capability metadata:

- context length
- max output
- streaming support
- tool-call support
- structured-output support
- vision/media input
- reasoning/thinking controls
- prompt-cache controls
- cache-retention controls
- parallel tool-call behavior
- model fallback/routing policy
- provider selection hints
- regional or endpoint constraints

Unknown values must remain unknown. Do not infer capability from API family
alone.

## Provider-Specific Notes

### Z.ai GLM

GLM Coding Plan exposes OpenAI Chat Completions and Anthropic Messages
endpoints.

Initial route posture:

- route provider: `zai`
- compatibility: OpenAI-compatible or Anthropic-compatible
- use as a backend for harnesses that allow custom endpoints
- not a harness adapter by itself

### MiniMax

MiniMax exposes an OpenAI-compatible API and long-context coding/agentic
models.

Initial route posture:

- route provider: `minimax`
- compatibility: OpenAI-compatible
- track model context and tool-call capability per model

### DeepSeek

DeepSeek exposes OpenAI and Anthropic-compatible base URLs and documents agent
tool integrations.

Initial route posture:

- route provider: `deepseek`
- compatibility: OpenAI-compatible or Anthropic-compatible
- useful through Claude-compatible, OpenAI-compatible, Pi, OpenCode, or custom
  route surfaces

### OpenRouter

OpenRouter is a gateway/router over many providers and models.

Initial route posture:

- route provider: `openrouter`
- compatibility: gateway/router plus OpenAI-compatible request shape
- route config must preserve provider-routing preferences
- model/provider attribution should be captured when the response exposes it

### OpenCode Zen

OpenCode Zen is an OpenCode model gateway.

Initial route posture:

- configure through the OpenCode adapter first
- route value is an OpenCode provider/model selection, not a harness adapter id
- keep OpenCode adapter instance id separate from the model route/provider id
- direct nucleus model route only if native model routing becomes a product
  feature

### OpenCode Provider Routes

OpenCode exposes configured providers and models through `provider/model`
selection strings.

Initial route posture:

- provider id and model id are parsed from `provider/model`
- route may carry OpenCode agent and variant options
- route must be bound to a configured OpenCode adapter instance
- OpenRouter, OpenCode Zen, and other OpenCode providers remain model routes
  inside the OpenCode harness adapter
- selecting a route bound to another OpenCode instance must be rejected

## Adapter Relationship

Harness adapter instances may reference one or more model routes.

Rules:

- route id never replaces provider instance id
- route changes do not create a new harness session identity unless the harness
  requires it
- route selection must be recorded in runtime metadata when visible
- route-level failures should be surfaced separately from harness transport
  failures where possible

## Scoped Route Overrides

Model routes may be overridden at project, session, or task-preference scope.

Override scopes:

- project override: durable project preference
- session override: temporary session preference
- task preference: selection input attached to a unit of work

Session overrides must not mutate project overrides or adapter instance
defaults. Task preferences may influence selection, but they do not become
durable route config unless promoted by an explicit project/session action.

Task model preferences can prefer routes, require one of a route set, inherit
project defaults, or inherit session defaults. They are assignment inputs, not
route definitions.

Allowed first-pass override fields:

- endpoint
- model id
- auth source
- billing/account source
- enabled state
- fallback policy
- provider selection hints
- regional constraints

Capability metadata is inherited from the base route unless a later evidence
pass defines a safe capability override rule. Unknown values remain unknown.

Overrides may affect selection or runtime config:

- selection input: narrows which configured adapter instance and route may
  receive work
- runtime config only: sent to a selected harness when the harness supports it
- disable route in scope: prevents that route from being selected in the
  scoped context

The selected adapter instance remains the authority for harness identity.
Resolved route state must retain base route id and applied override ids for
audit and recovery.

## Current Rust Surface

`nucleus-agent-protocol` now contains the first draft of:

- `ModelRoute`
- `ApiCompatibilityFamily`
- `RouteEndpoint`
- `AuthSource`
- `BillingAccountSource`
- `ModelRouteCapabilities`
- `RoutePolicy`
- `ModelRouteOverride`
- `ModelRouteOverrideScope`
- `ModelRouteOverrideEffect`
- `ModelRouteOverrideField`
- `ModelRouteInheritancePolicy`
- `ResolvedModelRoute`

These types describe routes and scoped route overrides only. They do not create
sessions, issue requests, implement override resolution, or imply direct model
invocation outside a harness runtime.

## Research Gaps

- Exact route schema for OpenAI-compatible provider-specific extensions.
- Whether nucleus needs direct model invocation outside harnesses.
- How to record actual provider selected by gateways.
- How model-route changes affect resumable sessions in Codex, Claude, Cursor,
  Kimi, Pi, and OpenCode.
- How OpenCode provider/model routes should reflect provider-selected gateway
  attribution when OpenRouter or OpenCode Zen route internally.
- Whether capability overrides are ever safe outside provider discovery.

## Next Task

Draft validation evidence and artifact reference semantics.
