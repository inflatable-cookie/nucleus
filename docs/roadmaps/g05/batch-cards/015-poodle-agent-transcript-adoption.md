# 015 Poodle Agent Transcript Adoption

Status: completed
Owner: Tom
Created: 2026-07-30
Milestone: `../005-observable-agent-chat-transcript.md`
Depends on: card 014
Auto-start next card: yes

## Objective

Stream durably projected activity to the caller and replace the bespoke chat
output with Poodle's transcript components.

## Scope

1. Add one window-scoped Tauri activity event.
2. Merge history and live activity by canonical turn and activity identity.
3. Apply exact delta and replacement semantics.
4. Map portable work to Poodle transcript items without native parsing.
5. Preserve actionable task and workflow receipts.

## Acceptance

- [x] live events are filtered by conversation identity
- [x] history produces the same transcript after restart
- [x] Poodle owns contiguous work grouping and collapse
- [x] completion-only work gains no invented start
- [x] reasoning summary and provider-unspecified assistant truth remain exact
- [x] final assistant activity and canonical message do not render twice
- [x] receipts remain actionable

## Evidence

- Tauri emits persisted activity only to the calling window
- the desktop merges history and live observations through one pure mapper
- `AgentTranscript` owns work runs, expansion, windowing, and bottom anchoring
- cancellation and task/workflow receipt controls remain outside transcript
  inference

## Stop Conditions

- the caller cannot scope activity to its own window and conversation
- Poodle requires provider-native fields
- receipt behavior would be removed
