# 067 Panel Runtime Authority And Status

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../022-terminal-browser-resource-host-cohesion.md`
Depends on: card 066
Auto-start next card: yes

## Objective

Settle when resource choice and runtime host state appear in Terminal and
Browser without adding global status chrome.

## Acceptance

- [x] resource target and runtime host evidence remain distinct
- [x] healthy local state stays quiet
- [x] Browser remains local and does not acquire a filesystem-resource selector
- [x] Terminal retry preserves exact project, panel, resource, and host routing

## Validation

- [x] Northstar docs QA passes

## Stop Conditions

- stop if UI state would become host or resource authority
- stop if Browser recovery weakens the native-child trust boundary

## Evidence

Contracts 003, 006, 028, and 029 now define one sparse boundary: durable panel
resource choice selects a route, while opened runtime evidence reports the
actual host. Healthy local state is suppressed. Browser remains a local,
URL-driven native child.
