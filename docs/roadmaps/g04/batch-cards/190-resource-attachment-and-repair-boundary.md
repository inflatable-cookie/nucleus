# 190 Resource Attachment And Repair Boundary

Status: planned
Owner: Codex
Updated: 2026-07-15
Milestone: `../039-multi-resource-attachment-and-targeting.md`
Auto-start next card: yes

## Objective

Add host-side folder and Git detection plus attach, update, repair, and remove
commands for project resources.

## Acceptance

- plain folders and Git repositories are detected without operator taxonomy
- resource identity survives movement and locator repair
- detach does not delete filesystem content
- remote host locators never require desktop-local access

## Stop Conditions

- attaching means copying or moving operator files
- Git becomes mandatory for a working resource
