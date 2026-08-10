# Subagent Group Transcript

Date: 2026-08-10
Card: `docs/roadmaps/g05/batch-cards/093-subagent-group-transcript.md`
Branch: `thread/093-subagent-group-transcript`

## Outcome

Implemented the desktop transcript projection for directory-backed provider
children.

- `agentChatTranscript.ts` folds known child activities within each turn into
  one ordered `subagent-group` per operation-local child.
- Primary activities keep the existing rendering. Child actors without a
  matching directory entry keep the existing attributed-row fallback; no
  identity is invented.
- Group data uses the directory's latest label and status. Running and
  non-terminal children receive the latest activity label or first content
  line as `activityLine`; terminal children receive it as `summary`.
- Detail lines retain every child activity label in first-seen order.
- `AgentChatPanel.svelte` passes groups only in All work view and forwards
  Poodle's `onOpenChild` to the existing exact operation/child actor selector.
  The existing All work selector provides the return path.
- No server, persistence, DTO, Poodle, or Swallowtail source changed.

The updated Poodle API is authoritative: `AgentTranscript` accepts
`onOpenChild(childId)` ([Poodle contract, lines 87-93](/Users/tom/Dev/projects/poodle/docs/contracts/components/agent-transcript.md#L87-L93))
and forwards the group id to `AgentSubagent`
([Poodle source, lines 364-373](/Users/tom/Dev/projects/poodle/packages/svelte/components/src/AgentTranscript.svelte#L364-L373)).
The child item shape and status vocabulary remain the `AgentSubagent` contract
([Poodle contract, lines 77-115](/Users/tom/Dev/projects/poodle/docs/contracts/components/agent-subagent.md#L77-L115));
`unknown` remains provider truth and Poodle renders it as `Unknown`
([Poodle contract, lines 132-141](/Users/tom/Dev/projects/poodle/docs/contracts/components/agent-subagent.md#L132-L141)).
The implementation preserves the timeline rule that actor attribution and
operation-local directories remain exact and observational
([timeline contract, lines 190-212](../contracts/019-conversation-timeline-contract.md#L190-L212);
[Swallowtail contract, lines 67-89](/Users/tom/Dev/projects/swallowtail/docs/contracts/045-subagent-topology-observation-and-control.md#L67-L89)).

## Fixtures

- `groups known child activities while preserving primary ordering`
- `keeps unknown child status literal and falls back without a directory`
- Existing `keeps main and operation-local child activity distinct` fixture
  covers the exact child attribution route used by the click-through.

## Commands And Exit States

1. `bun install` in `apps/desktop` — exit 0; refreshed the file-linked Poodle
   component copy.
2. `bun test src/lib/agentChatTranscript.test.ts` — exit 0; 22 passed.
3. `bun test src` — exit 0; 69 passed.
4. `bunx vitest run --config vitest.config.ts` — exit 0; 10 files and 23 tests
   passed.
5. `effigy desktop:test` — exit 0; 69 Bun tests and 10 Vitest files / 23 tests
   passed.
6. `git diff --check` — exit 0.
7. `effigy desktop:check` — exit 1 on three pre-existing Longhorn export
   errors in `apps/desktop/src/lib/workspaceLayout.ts`:
   `assertCompatibleLayoutMutationCommand`,
   `assertCompatibleLayoutMutationOutcome`, and
   `assertCompatibleLayoutMutationRejectionCode` are absent from the linked
   Longhorn package, which exports the `assertValid...` names instead. No
   out-of-scope Longhorn source was changed.

## Acceptance State

- [x] child activities render as one `subagent-group` per child per turn
- [x] running children show live activity; terminal children show summary;
  unknown status remains literal through Poodle
- [x] `onOpenChild` selects exact child attribution; All work returns to the
  combined transcript
- [x] fixtures and desktop tests pass
- [ ] desktop check blocked by the unrelated linked-Longhorn export drift

No roadmap, milestone, card, dispatch, or status file was changed.
