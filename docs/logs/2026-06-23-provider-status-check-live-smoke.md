# 2026-06-23 Provider Status Check Live Smoke

## Context

The operator approved provider smoke checks after the status/check family had
been modeled as stopped records.

## Command Shape

Target:

- provider: GitHub CLI
- repository: `cli/cli`
- pull request: `13705`

Selected command fields:

- `bucket`
- `completedAt`
- `description`
- `event`
- `link`
- `name`
- `startedAt`
- `state`
- `workflow`

## Result

The approved `gh pr checks` smoke completed with exit code `0`.

Sanitized evidence:

- checks: `18`
- pass: `11`
- fail: `0`
- pending: `0`
- skipped: `7`
- cancelled: `0`

## Guardrails

- No provider write was requested or executed.
- No task mutation was requested or executed.
- No callback, interruption, or recovery execution was requested.
- No raw provider stdout, stderr, headers, request body, response body, or
  payload was committed to the repo.
- The evidence promoted into code tests is limited to target, selected fields,
  exit code, counts, and guardrail flags.

## Follow-Up

This smoke proves the second provider live-read family can run under explicit
approval. It does not authorize automatic provider execution, generalized CI
ingestion, UI-triggered provider reads, or provider writes.
