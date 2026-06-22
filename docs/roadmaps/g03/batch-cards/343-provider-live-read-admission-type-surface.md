# 343 Provider Live Read Admission Type Surface

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../088-provider-live-read-admission-gate.md`

## Purpose

Define the server-side type surface for fixture-backed provider live-read
admission.

## Acceptance Criteria

- [x] Admission input names provider context, read operation family, target
  refs, credential-status evidence refs, network-authority refs, payload policy
  refs, and sanitization refs.
- [x] Admission records expose status, blockers, evidence refs, and no-effect
  flags.
- [x] Supported operation families are read-only only.
- [x] No credential material, raw payload, provider write, or task mutation
  field is added.
