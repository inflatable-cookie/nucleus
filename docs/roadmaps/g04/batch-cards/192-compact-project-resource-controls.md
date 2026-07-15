# 192 Compact Project Resource Controls

Status: completed
Owner: Codex
Updated: 2026-07-15
Milestone: `../039-multi-resource-attachment-and-targeting.md`
Auto-start next card: yes

## Objective

Add project-menu resource management, default selection, and repair controls
without turning resources into permanent workspace chrome.

## Acceptance

- Open folder or repository detects and attaches the correct kind
- resource list shows name, kind, host, role, and truthful health
- selectors appear only for multiple compatible targets or repair
- advanced metadata stays behind detail popovers

## Stop Conditions

- every panel gains a permanent project topology toolbar
- local and remote resource labels imply paths exist on the client

## Outcome

The project menu now opens a compact resource manager that detects and
attaches folders or Git repositories, exposes truthful role, host, kind, and
health, and keeps identifiers and branch metadata behind details. Default,
repair, and remove actions reuse the host-owned resource command family;
removal never touches files. Chat, editor, and terminal panels stay quiet for
zero or one healthy resource and gain a persisted selector only when choice or
repair needs operator input. Existing Nucleus seed records migrate from the
legacy local-host label so repair works through the same authority boundary.
