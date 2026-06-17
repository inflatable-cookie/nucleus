# 172 Define Command Artifact Payload Retention Policy

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Define how command artifact payloads can be retained without putting raw output
into normal state, logs, or event payloads.

## Scope

- Define stdout/stderr artifact payload classes.
- Define default retention and approval posture.
- Define redaction and secret-scan expectations.
- Preserve evidence refs instead of embedding raw output.

## Out Of Scope

- Artifact storage implementation.
- Process spawning.
- Desktop artifact viewers.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-command-policy`

## Acceptance Criteria

- Artifact payload policy is separate from command evidence.
- Default raw output retention is conservative.
- Future implementation can test policy before storing payloads.

## Closeout

- Added a command artifact payload storage policy helper.
- Raw stdout, stderr, combined output, and terminal transcript payloads require
  full-output approval, scan, and redaction policy.
- Sanitized summaries remain allowed under conservative summary/reference
  retention.
- Promoted payload retention rules into the server boundary contract.
