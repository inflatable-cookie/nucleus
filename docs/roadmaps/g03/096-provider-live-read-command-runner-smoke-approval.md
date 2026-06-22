# 096 Provider Live Read Command Runner Smoke Approval

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Prepare the first Nucleus-owned provider live-read command-runner smoke behind
an explicit approval checkpoint.

This lane should turn the command handoff into an auditable smoke plan for the
same field-limited `gh repo view` repository metadata refresh. It must not run
the command without explicit operator approval in the current lane closeout.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/logs/2026-06-22-provider-live-read-smoke-evidence.md`
- `docs/roadmaps/g03/093-provider-live-read-server-owned-executor.md`
- `docs/roadmaps/g03/095-provider-live-read-executor-command-runner-handoff.md`

## Goals

- [x] Add a command-runner smoke target for repository metadata refresh.
- [x] Add an approval checklist for Nucleus-owned read-only command execution.
- [x] Add stopped smoke request records that name the exact command and target.
- [x] Keep live execution paused until explicit approval.

## Execution Plan

- [x] Add smoke target and authority checklist records for command-runner live
  reads.
- [x] Add stopped command-runner smoke request records.
- [x] Add diagnostics and validation for approval-required states.
- [x] Pause at operator approval before running `gh`.

## Batch Cards

Completed cards:

- `batch-cards/381-provider-live-read-command-smoke-target.md`
- `batch-cards/382-provider-live-read-command-smoke-approval-checklist.md`
- `batch-cards/383-provider-live-read-command-stopped-smoke-request.md`
- `batch-cards/384-provider-live-read-command-smoke-validation.md`

## Acceptance Criteria

- [x] Smoke records identify the repo target, command descriptor, and command
  handoff.
- [x] Missing approval keeps the command-runner smoke stopped.
- [x] Provider writes, task mutation, callback/interruption/recovery execution,
  raw payload retention, and credential material storage remain blocked.
- [x] The next task is an explicit operator approval checkpoint or a stop.

## Current Slice

Completed:

- implemented cards 381-384 as one stopped command-runner smoke approval
  batch.
- operator approval was granted after the checkpoint.
- the approved read-only `gh repo view octocat/Hello-World --json
  nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt`
  smoke completed successfully.
- next lane should promote the observed selected-field result into
  server-owned executor evidence without broadening provider authority.

## Stop Conditions

- Stop before automatic or UI-triggered `gh` execution.
- Stop before provider writes, comments, status/check writes, review actions,
  labels, branch mutation, merges, or pull-request mutation.
- Stop before storing raw provider stdout/stderr, headers, response bodies, or
  credential material.
