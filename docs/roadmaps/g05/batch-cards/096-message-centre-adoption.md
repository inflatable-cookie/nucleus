# 096 Message Centre Adoption And Toast Delivery

Status: completed
Owner: Tom
Created: 2026-08-11
Milestone: none yet (shell quality lane)
Depends on: poodle `MessageCenter` + `ToastHost`/`ToastStack` (poodle main;
  contract `poodle/docs/contracts/components/message-center.md`)
Auto-start next card: no

## Objective

Adopt poodle's `MessageCenter` as the notification archive and
`ToastHost`/`ToastStack` as the delivery surface, replacing the current
`NotificationPopover` rendering. New warning-and-above notifications (the
existing toast predicate) must appear as toasts when they happen and remain
inspectable in the archive from the titlebar trigger, next to the settings
button.

## Governing Refs

- `poodle/docs/contracts/components/message-center.md` — the component
  contract: host-owned items, request-style callbacks, unread derived from
  items, archive is not a live region (delivery is toasts)
- Poodle contracts/source for `ToastHost` and `ToastStack` — read them
  before wiring delivery
- `docs/contracts/032-longhorn-desktop-systems-integration-contract.md` —
  consumer boundary; longhorn owns the retained ledger, unseen/seen state
- `apps/desktop/src/lib/notifications/runtime.svelte.ts` — the
  `NotificationSession` wiring (`records`, `toasts`, `markSeen`,
  `dismiss`, `dismissToast`, `invokeAction`)
- `apps/desktop/src/App.svelte:419-436` — titlebar actions; the
  notification trigger already sits next to Settings

## Environment Notes

- The worktree parent (`nucleus-wt/`) symlinks `poodle` and `longhorn` to
  the live sibling checkouts. `MessageCenter` is not in the npm 0.1.0
  release; after `bun install` in `apps/desktop`, run
  `effigy deps link bun ../../../poodle` from `apps/desktop`. If that errors
  about a duplicate svelte copy, delete
  `/Users/tom/Dev/projects/poodle/node_modules/.bun/svelte@*` and retry.
  Do not run `bun install` again after linking.

## Worker Rules

- Execute the card exactly; no planning authority; no sub-agents.
- Do NOT touch roadmap/milestone/card/dispatch status files — deliverables +
  batch log only.
- Poodle and longhorn sources are read-only; an API gap is a stop-condition
  finding with citations.
- Commit on branch `thread/096-message-centre-adoption` and push with
  `git push -u origin thread/096-message-centre-adoption`; no merge.

## Scope

- `apps/desktop/src/lib/notifications/NotificationPopover.svelte`:
  re-render through `MessageCenter` (or replace the component with a thin
  adapter — keep the file/props surface App.svelte consumes, including the
  `onOpenChange` and `onSurfaceGeometryChange` plumbing that drives
  `setNativePanelOverlayOpen` / `updateNativePanelOverlayGeometry`).
  - Map `session.records` → `MessageCenterItem`: severity → `tone`
    (warning/error/critical at minimum), title, body → `message`, source →
    `meta`, timestamp, seen state → `read`.
  - `onReadChange` → `markSeen`; `onRemove` → `dismiss`; `onMarkAllRead` →
    mark all unseen seen (bulk mutation if the port offers one, per-record
    otherwise — cite the port surface in the log); `onItemSelect` →
    `select`, and `invokeAction` where the record carries an admitted
    action.
- `apps/desktop/src/App.svelte`: mount the poodle toast surface
  (`ToastHost`/`ToastStack` per the poodle contract) fed by
  `session.toasts`, wired to `dismissToast`. Placement per the poodle
  contract's guidance; it must layer above workspace content without
  shifting layout.
- `apps/desktop/src/lib/notifications/notifications.vitest.ts`: update for
  the new rendering (archive rows, unread count, toast presence).
- Batch log `docs/logs/2026-08-11-message-centre-adoption.md`.

Out of scope: routing desktop-caught errors into the ledger (card 097),
server or longhorn changes, the existing severity toast predicate
(`shouldToastNotification` stays as-is unless the poodle toast contract
requires a shape change — cite if so).

## Acceptance

- [x] titlebar trigger (next to Settings) opens the `MessageCenter`
  archive with unread count; read/remove/mark-all work against the ledger
- [x] new warning/error/critical notifications appear as toasts and are
  archived; dismissing a toast does not remove the archive record
- [x] native overlay geometry wiring intact (no native panel regressions)
- [x] fixtures + `effigy desktop:check` + `effigy desktop:test` pass

## Closeout

Merged to main as `44ed434b` (worker commit `77548fc0`, deepseek flash
xhigh, clean first run). `NotificationPopover` now renders through poodle
`MessageCenter`; delivery moved from longhorn's `NotificationToastHost` to
poodle `ToastHost` fed by a thin projection store over `session.toasts`.
Two port limits handled per the card (no mark-unseen mutation; no bulk
mark-all — per-record loop), cited in code and log. One poodle API gap
worth feeding back: `MessageCenter` does not forward the underlying
`Popover`'s surface-geometry callback, so the adapter observes the
portalled surface directly to keep the native overlay plumbing working —
a forwarding prop on `MessageCenter` would remove that workaround.

## Evidence

- Batch log with commands + exit states and fixture names.

## Stop Conditions

- The poodle toast or message-centre API cannot express the session's
  projections without poodle changes → stop with citations
- The overlay geometry plumbing cannot be preserved through `MessageCenter`
  → stop and report
- The port lacks the mutations the callbacks need (e.g. no mark-all path
  and per-record is rejected) → stop and report
