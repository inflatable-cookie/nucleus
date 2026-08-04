# 069 Terminal Browser Runtime Presentation

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../022-terminal-browser-resource-host-cohesion.md`
Depends on: card 068
Auto-start next card: yes

## Objective

Give Terminal and Browser sparse, theme-aligned opening, failure, retry, and
runtime-host presentation without inventing shared runtime semantics.

## Acceptance

- [x] Terminal uses current theme background and text tokens
- [x] Terminal opening and failure remain panel-local and retry the exact target
- [x] only actual non-local Terminal session evidence shows a host label
- [x] Browser child start failure offers one exact trusted retry
- [x] normal Browser and local Terminal readiness stay quiet

## Validation

- [x] focused presentation fixtures, desktop checks, and panel guards pass

## Stop Conditions

- do not add a global connection bar
- do not make Browser remote-host or project-resource capable
- do not expose host-local paths, shells, cookies, or credentials

## Evidence

Terminal now resolves its xterm background, foreground, cursor, and muted ANSI
color from the active Poodle theme. Opening and retryable open failures remain
compact overlays; a healthy embedded session stays quiet and only the actual
session snapshot can expose a non-local host. Browser retries the same stable
native island after replacing its runtime listener. Nine focused Bun fixtures,
desktop checking/build, and 11 panel guards pass.
