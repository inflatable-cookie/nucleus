# 073 Provider Selection And Session Defaults

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../023-memory-provider-and-advanced-control-cohesion.md`
Depends on: card 072
Auto-start next card: yes

## Objective

Consolidate provider identity, route choice, model discovery, reasoning, and
harness mode into one truthful new-session selection path.

## Acceptance

- [x] Nucleus consumes one admitted provider-instance catalogue rather than parsing native payloads
- [x] one configured provider stays read-only and does not create a redundant selector
- [x] multiple selectable providers receive an explicit selector in Settings and the composer
- [x] model and reasoning options remain scoped to the selected provider route
- [x] every provider, model, reasoning, or harness-mode change prepares a fresh session
- [x] unavailable, unauthenticated, and unsupported providers remain visible but cannot be selected as ready

## Validation

- [x] focused catalogue, settings, composer, replacement-session, and persistence fixtures pass

## Stop Conditions

- pause if Swallowtail exposes no portable provider-instance catalogue
- do not create provider ids, route capabilities, or credential readiness in TypeScript

## Evidence

- Swallowtail Contract 047 now defines and implements
  `ConfiguredProviderInstanceCatalogue`, exact instance admission, safe
  credential posture, bound model-catalogue input, and conservative selection
  readiness.
- The catalogue remains consumer-assembled and adds no provider router,
  default, fallback, discovery effect, or credential authority.
- Contracts 004, 010, and 030 promote the Nucleus consumer binding and fresh-
  session selection rules. The previous stop condition is cleared.
- `AgentAdapterRegistry` assembles the Swallowtail catalogue and retains the
  Nucleus runtime binding for each admitted instance. The server projects only
  safe identity, readiness, credential posture, and bound model data.
- persisted defaults and Agent Chat sessions carry exact instance, revision,
  facade, optional provider, model, reasoning, harness, and resource identity.
- Settings and the composer share provider-scoped selection helpers. A
  selector appears only when at least two instances are ready.
- focused Rust route, replacement-session, settings persistence, Bun selection,
  mounted Settings, Svelte, and desktop build checks pass.
