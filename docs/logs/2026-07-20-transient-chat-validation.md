# Transient Chat Validation

Date: 2026-07-20

## Outcome

Transient lifecycle behavior now has focused server coverage. Resource-free
chat, restart survival, explicit expiry, active-turn protection, and in-place
promotion are verified without inventing a filesystem resource.

## Race Boundary

Expiry scans stored turns and refuses deletion while any project chat turn is
active. Chat also rechecks project presence after persisting its started turn
and before provider submission. This closes both race orders:

- a persisted active turn blocks expiry
- an expiry that wins first prevents provider work from starting

## Evidence

- transient projects survive restart until explicit expiry
- active turns block expiry until terminal
- promotion retains project, conversation, session, and message identity
- task creation, Goal creation, and resource attachment promote in place
- resource-free chat uses host home with `resource:none`
- focused server tests, desktop tests, and desktop type checks pass

## Operator Confirmation

The operator confirmed both remaining presentation checks on 2026-07-20:

- quiet one-resource Agent Chat, Editor, and Terminal presentation
- immediate, uncluttered New chat creation and visible continuity after Keep or
  Name
