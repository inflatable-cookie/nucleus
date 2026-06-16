# Provider Routing And Model Surfaces

Status: open
Owner: Tom
Updated: 2026-06-15

## Purpose

Track model/provider integrations that may power harnesses but are not
necessarily harness adapters themselves.

This avoids mixing two different layers:

- harness adapters: sessions, tools, approvals, event streams, process/runtime
  lifecycle
- model/provider routes: inference APIs, model catalogs, billing, fallback,
  routing, provider-specific request fields

## Sources

- Z.ai GLM coding endpoint:
  `https://docs.z.ai/devpack/tool/others`
- MiniMax OpenAI-compatible API:
  `https://platform.minimax.io/docs/api-reference/text-openai-api`
- DeepSeek API docs:
  `https://api-docs.deepseek.com/`
- DeepSeek Anthropic API docs:
  `https://api-docs.deepseek.com/guides/anthropic_api`
- OpenRouter quickstart:
  `https://openrouter.ai/docs/quickstart`
- OpenRouter provider routing:
  `https://openrouter.ai/docs/guides/routing/provider-selection`
- OpenRouter model API:
  `https://openrouter.ai/docs/api/api-reference/models/get-models`
- OpenCode Zen:
  `https://opencode.ai/docs/zen/`
- OpenCode providers:
  `https://opencode.ai/docs/providers/`

## Initial Findings

- Z.ai GLM Coding Plan exposes both OpenAI Chat Completions and Anthropic
  Messages endpoints. It is a backend route for tools like Cline, Goose, and
  Claude-compatible workflows, not a full nucleus harness by itself.
- MiniMax exposes an OpenAI-compatible API. Current docs list MiniMax-M3 as a
  long-context model for agentic reasoning, tool use, coding, and long-context
  tasks.
- DeepSeek exposes OpenAI and Anthropic-compatible base URLs and explicitly
  documents use in agent tools. It should be treated as a model/provider route
  unless paired with a harness.
- OpenRouter is a routing layer over many models and providers. It supports
  provider selection/routing controls and model discovery. It should be a
  routing provider, not a harness adapter.
- OpenCode Zen is an OpenCode model gateway. It works inside OpenCode as a
  provider, so nucleus should reach it through the OpenCode adapter unless a
  direct model-routing feature is added later.

## Contract Implications

- Harness adapters must not be hard-coded to one model provider.
- Provider routing belongs under adapter configuration and a separate
  model-route abstraction, not inside core session identity.
- Model routes need capability metadata distinct from harness capabilities:
  context length, tool-call support, reasoning controls, cache controls,
  OpenAI/Anthropic compatibility, routing/fallback policy, and billing source.
- OpenAI-compatible does not mean behavior-compatible. Provider-specific fields
  such as reasoning controls, prompt cache fields, and model names must remain
  explicit.

## Decision

Create a separate model-route contract now.

Reason:

- Kimi, Pi, OpenCode, and Claude-compatible workflows can each route through
  many model providers.
- Model/provider routes change more often than harness lifecycle contracts.
- Billing, quotas, model catalogs, context windows, reasoning controls, and
  provider fallbacks must not pollute adapter session identity.
- The harness adapter contract needs to refer to model routes without owning
  their full semantics.

## Open Questions

- Should nucleus expose a first-class model router independent of harness
  adapters, or delegate routing to each harness where possible?
- Which providers need direct support because their coding subscriptions are
  valuable outside a specific harness?
- Should OpenRouter and OpenCode Zen be configured at nucleus level or only
  through adapters that already know how to use them?
- How should nucleus record which model/provider route produced an agent event
  when the harness abstracts that detail away?

## Next Task

Research Nucleus native harness and steward runtime semantics.
