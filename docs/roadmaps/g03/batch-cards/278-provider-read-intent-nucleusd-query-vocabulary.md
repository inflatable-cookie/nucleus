# 278 Provider Read-Intent Nucleusd Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../074-provider-read-intent-nucleusd-query.md`

## Purpose

Add `provider-read-intent` to the `nucleusd query` command vocabulary.

## Acceptance Criteria

- [x] CLI parser accepts `query provider-read-intent`.
- [x] Help text lists the new query domain.
- [x] Unknown query domains still fail closed.
- [x] No provider authority is added by parsing the command.
