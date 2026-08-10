# Subagent Group Transcript

Date: 2026-08-10
Card: `docs/roadmaps/g05/batch-cards/093-subagent-group-transcript.md`
Branch: `thread/093-subagent-group-transcript`

## Outcome

Stopped before implementation. The required child click-through cannot be wired
through the existing authoritative Poodle transcript host without changing
Poodle or relying on an unstable DOM workaround.

The card requires `AgentChatPanel.svelte` to map `subagent-group` items to the
Poodle component and have `onOpenChild` select the child
([card, lines 59-60](../roadmaps/g05/batch-cards/093-subagent-group-transcript.md#L59-L60)).
The merged `AgentSubagent` contract defines the required `onOpenChild` prop
([Poodle contract, lines 78-90](/Users/tom/Dev/projects/poodle/docs/contracts/components/agent-subagent.md#L78-L90)).
However, the authoritative `AgentTranscript` component used by the panel
accepts no `onOpenChild` callback ([Poodle source, lines 34-56](/Users/tom/Dev/projects/poodle/packages/svelte/components/src/AgentTranscript.svelte#L34-L56))
and renders `AgentSubagent` without forwarding one
([Poodle source, lines 361-369](/Users/tom/Dev/projects/poodle/packages/svelte/components/src/AgentTranscript.svelte#L361-L369)).
The panel currently supplies only the transcript-level callbacks
([panel, lines 1098-1110](../../apps/desktop/src/lib/AgentChatPanel.svelte#L1098-L1110)).

Adding the missing forwarding API is a Poodle source change. Reaching into the
rendered DOM to infer a child from its label would be a workaround, would fail
for duplicate labels, and would not use the authoritative component API. The
card explicitly marks Poodle sources out of scope
([card, lines 67-69](../roadmaps/g05/batch-cards/093-subagent-group-transcript.md#L67-L69))
and says scope pressure toward Poodle changes is a stop condition
([card, lines 85-90](../roadmaps/g05/batch-cards/093-subagent-group-transcript.md#L85-L90)).

No production code or fixtures were changed. No roadmap, milestone, card, or
dispatch status file was changed.

## Commands And Exit States

1. `bun install` in `apps/desktop` — exit 0.
2. Source inspection of the merged Poodle contract and transcript implementation
   — stop-condition confirmed; desktop check and tests not run.

## Not Verified

- Child grouping and status rendering.
- `onOpenChild` navigation.
- `effigy desktop:check`.
- `effigy desktop:test`.

## Next Move

Add an explicitly scoped Poodle transcript callback (or provide an equivalent
host composition API), then resume card 093 without changing the provider or
persistence layers.
