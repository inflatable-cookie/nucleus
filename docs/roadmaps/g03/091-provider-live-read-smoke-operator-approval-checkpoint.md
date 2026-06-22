# 091 Provider Live Read Smoke Operator Approval Checkpoint

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Pause before the first live provider read smoke.

The stopped approval gate exists. The next step requires explicit operator
approval naming the concrete provider, repo, operation, credential lease,
network authority, payload policy, retention policy, and evidence expectations.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/090-provider-live-read-smoke-approval-gate.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/implementation-gap-index.md`

## Approval Requirements

- Provider and host: GitHub on `github.com`.
- Repo scope: `octocat/Hello-World`.
- Operation family: repository metadata refresh.
- Target refs: `remote-repo:octocat/Hello-World`.
- Credential lease ref: local `gh` authenticated account metadata; credential
  material not recorded.
- Network-read authority ref: explicit operator approval in this session.
- Payload and sanitization policy refs: selected sanitized metadata fields.
- Retention policy ref: no raw provider payload retention.
- Expected evidence refs and success criteria: sanitized repo metadata summary
  in `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`.

## Result

Approved read-only smoke completed.

Evidence:

- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`

The smoke used `gh` directly. It did not add or prove a Nucleus-owned provider
executor.

## Stop Conditions

- Stop before real provider network calls.
- Stop before credential material resolution.
- Stop before provider writes, status/check writes, comments, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before task mutation, callback execution, interruption execution, or
  recovery execution.
- Stop before raw provider payload retention.
