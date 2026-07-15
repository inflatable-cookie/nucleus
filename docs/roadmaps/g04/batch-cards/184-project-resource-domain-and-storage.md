# 184 Project Resource Domain And Storage

Status: completed
Owner: Codex
Updated: 2026-07-15
Milestone: `../037-project-resource-foundation.md`
Auto-start next card: yes

## Objective

Replace the repo-only project domain and lossy display record with persisted
resource memberships, retention, working defaults, and management-projection
refs.

## Acceptance

- zero-resource, folder, Git, and multi-resource projects round-trip
- existing repo records migrate without losing Git or repair metadata
- paths remain host-local locators rather than identity
- no parallel legacy project model remains

## Stop Conditions

- migration cannot preserve an existing project id
- storage requires a local path for every project

## Outcome

The repo-only `Project` model is replaced by one resource-aware domain. Storage
schema v2 persists transient/durable retention, folder and Git resources,
authority host, locator history, Git and repair metadata, working defaults, and
management targets. Schema-v1 display records migrate on decode while current
control summaries are derived from the full record.
