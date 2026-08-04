# 061 Conversation Attachment And Sidebar Sync

Status: completed
Owner: Tom
Created: 2026-08-03
Milestone: `../020-shared-work-context.md`
Depends on: card 060
Auto-start next card: yes

## Objective

Make Agent Chat panels and both sidebar thread views agree on the active
conversation.

## Acceptance

- [x] opening a thread activates or creates one Agent Chat panel
- [x] the selected panel retains its conversation through switch and restart
- [x] Projects and Threads show the same active-thread highlight
- [x] multiple Agent Chat panels keep distinct attachments while the active one
  drives project focus

## Validation

- [x] focused desktop fixtures cover cross-project, remount, panel activation,
  close, and restart behavior

## Stop Conditions

- do not rewrite conversation history or infer provider thread identity

## Evidence

Projects, Threads, and the workspace stage share the App-owned active
conversation id. Thread changes refresh both sidebar projections. Agent Chat
attachments persist per panel; focused Rust and workspace-session fixtures
cover distinct attachments, project isolation, remount, and restart without a
provider turn.
