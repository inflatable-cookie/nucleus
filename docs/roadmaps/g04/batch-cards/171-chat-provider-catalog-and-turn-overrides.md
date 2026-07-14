# 171 Chat Provider Catalog And Turn Overrides

Status: completed
Owner: Codex
Updated: 2026-07-13
Milestone: `../033-floating-agent-chat-composer.md`
Auto-start next card: yes

## Objective

Expose the local provider model catalog and apply selected model/reasoning to
the current and subsequent turns on one durable thread.

## Validation

- catalog decoding and route normalization tests
- request serialization and focused server tests

## Outcome

- `model/list` supplies visible models and supported reasoning effort metadata.
- Chat requests carry normalized route choices into sticky `turn/start` fields.
- Successful turns update the durable session route without changing sandbox or
  approval policy.
