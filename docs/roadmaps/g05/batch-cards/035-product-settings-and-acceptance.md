# 035 Product Settings And Acceptance

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../011-provider-and-product-settings.md`
Depends on: card 034
Auto-start next card: yes

## Objective

Audit product settings authority, admit only pages backed by durable schemas,
and close provider and product settings acceptance.

## Acceptance

- [x] every page maps to an existing Nucleus schema and authority boundary
- [x] advanced controls stay out of normal panel chrome
- [x] persistence, restart, project scope, and narrow-layout behavior pass
- [x] unsupported settings remain absent or explicitly unavailable

## Validation

- [x] focused desktop, Svelte, accessibility, and native Settings checks pass

## Stop Conditions

- do not invent settings solely to populate the shell

## Evidence

- the registry remains intentionally limited to General, Appearance, and
  Agent & models; Workspace, Browser, Terminal, Forge, and Advanced are absent
  because they have no durable user-preference schemas
- project layouts remain project-scoped documents rather than global Settings
  defaults
- mounted Settings acceptance passes all three cases and asserts the unsupported
  pages remain absent
- native release acceptance opened the dialog through accessibility, exercised
  the provider-managed revoke no-op, proved the narrow layout, restarted the
  app, and recovered the saved window geometry and current provider defaults
- the final native build retains Poodle's standard titlebar `IconButton`; the
  apparent missing control was a stale debug-process observation, not a layout
  defect
- no authenticated provider or credential effect ran
