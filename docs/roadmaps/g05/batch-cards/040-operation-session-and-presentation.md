# 040 Operation Session And Presentation

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../013-cross-panel-operation-catalogue.md`
Depends on: card 039
Auto-start next card: yes

## Objective

Expose active and recent host work through one isolated renderer session and
compact cross-panel presentation.

## Acceptance

- [x] active work stays visible after leaving its initiating panel
- [x] cancellation request and confirmed cancellation remain distinct
- [x] terminal state is sticky and late progress cannot reopen work
- [x] renderer teardown does not cancel host work

## Validation

- [x] focused session, projection, remount, project-switch, and shutdown fixtures pass

## Stop Conditions

- do not persist detailed product evidence in the operation catalogue
