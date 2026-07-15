# 191 Workspace Resource Target Resolution

Status: planned
Owner: Codex
Updated: 2026-07-15
Milestone: `../039-multi-resource-attachment-and-targeting.md`
Auto-start next card: yes

## Objective

Route chat execution, editor, terminal, browser, diff, and task work through an
explicit compatible resource or the project's truthful default.

## Acceptance

- callers stop using project `primary_location` as authority
- zero-resource actions return capability guidance rather than project failure
- one-resource projects require no extra selection UI
- multi-resource targeting is retained across panel remount and restart

## Stop Conditions

- panel code reads host paths directly to choose authority
- one global default hides task- or panel-specific resource attribution
