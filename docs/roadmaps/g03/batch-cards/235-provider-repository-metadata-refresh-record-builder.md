# 235 Provider Repository Metadata Refresh Record Builder

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../064-stopped-provider-repository-metadata-refresh-control.md`

## Purpose

Build stopped provider repository metadata refresh records from provider
context refs.

## Acceptance Criteria

- [x] Refresh ids derive deterministically from provider context refs.
- [x] Records preserve provider instance, forge provider, remote repo,
  operation family, credential-status evidence, repository-metadata evidence,
  and sanitization policy refs.
- [x] Missing refs produce repair-required records.
- [x] Real credential, provider, callback, interruption, recovery, task, and
  raw payload effect requests produce blocked records.
