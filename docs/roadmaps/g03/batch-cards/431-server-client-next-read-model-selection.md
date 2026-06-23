# 431 Server Client Next Read Model Selection

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../108-server-client-workflow-hardening.md`

## Purpose

Select the next read-only model or pair of models to harden through the
server/client path.

## Acceptance Criteria

- [x] Selection is based on the gap matrix.
- [x] Governing contracts are cited.
- [x] Provider execution, writes, task mutation, credential material storage,
  raw payload retention, and UI-triggered provider reads remain blocked.

## Result

Selected task timeline and project authority-map read-only control parity as
the next implementation batch.
