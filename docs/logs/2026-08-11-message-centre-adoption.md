# Message Centre Adoption And Toast Delivery

Date: 2026-08-11
Card: `docs/roadmaps/g05/batch-cards/096-message-centre-adoption.md`
Branch: `thread/096-message-centre-adoption`

## Outcome

Adopted poodle `MessageCenter` as the notification archive and poodle
`ToastHost`/`ToastStack` as the delivery surface in `apps/desktop`,
replacing the `NotificationPanel`-inside-`Popover` archive and the longhorn
`NotificationToastHost` wrapper.

- `NotificationPopover.svelte` is now a thin adapter over `MessageCenter`
  with the same props surface App.svelte consumes (`session`,
  `onOpenChange`, `onSurfaceGeometryChange`).
  - Records project to `MessageCenterItem`: `id` = `notificationId`,
    `title`, `message` = `draft.summary`, `meta` = `draft.sourceId`,
    `timestamp` = `draft.presentationTimeUnixMs` (null renders no time),
    `read` = `readState === "seen"`, `tone` = `notificationStatusTone`
    (longhorn `tone.ts` collapses error/critical → `danger`).
  - `onReadChange` → `markSeen` in the read direction only;
    `onRemove` → `dismiss`; `onMarkAllRead` → per-record `markSeen` for
    unseen records; `onItemSelect` → `select` plus `invokeAction` when the
    record carries an action admitted by `isAdmittedNotificationAction`
    (the shared predicate now backs the executor too).
  - Unread count is derived from items per the MessageCenter contract
    ([contract §5](https://github.com/inflatable-cookie/poodle/blob/main/docs/contracts/components/message-center.md#L5-User-content)).
    The trigger is always present, so the old "absent when empty" gating is
    gone; the empty archive shows the MessageCenter empty state.
- App.svelte mounts poodle `ToastHost` directly
  (bottom-end, `autoDismissMs` 6000, `stickyTones ["danger"]`), fed by a
  `ToastHostStore` projected from `session.toasts` in the new
  `lib/notifications/toastHost.ts`; `dismiss` → `dismissToast`,
  `onAction` → `invokeAction` through the session executor. The longhorn
  `NotificationToastHost` import is removed.
- Native overlay plumbing preserved: MessageCenter does not forward surface
  geometry, so the adapter observes the portalled surface itself via
  `observeOverlaySurfaceGeometry` (`poodle-core` `dom/overlay-geometry.ts`)
  with `createInstanceId("notification-surface")` and forwards
  upsert/remove to `onSurfaceGeometryChange` while open, matching the
  previous Popover's `bottom-end` placement. `onOpenChange` keeps driving
  `setNativePanelOverlayOpen`.

## Port Surface Citations

- No bulk mark-all-read mutation exists on the port:
  `NotificationMutationCommand` kinds are `add | replace | markSeen |
  dismiss | clear | changeRetention` (longhorn
  `notifications/generated/protocol.ts`); `markSeen` carries a single
  `notificationId`. `clear` removes records and does not set read state.
  `onMarkAllRead` therefore loops per-record — the card's per-record
  fallback.
- No mark-unseen consumer path exists (`NotificationSession`/`Controller`
  expose only `markSeen`); the request-style `onReadChange(id, false)`
  callback is deliberately not acted on.
- `ToastHostStore.dismiss` maps to `session.dismissToast`, which clears only
  the transient toast projection — the retained archive record is untouched
  (covered by a fixture).

## Fixtures

- `message centre trigger derives unread count and opens the archive`
- `archive read/remove/mark-all callbacks mutate the ledger session`
- `selecting an archive row selects and runs admitted actions only`
- `toast surface renders session toasts; dismiss never touches the archive`
- `toast action requests run through the session executor`
- `only attention severities become transient toasts` (kept)
- `semantic actions rerun command admission and reject unknown references`
  (kept)

## Commands And Exit States

1. `effigy desktop:check` — exit 0; 1300 files, 0 errors, 0 warnings.
2. `effigy desktop:test` — exit 0; `bun test src` 71 passed / 0 failed (13
   files), vitest 10 files / 27 tests passed.
3. `git diff --check` — exit 0.

No poodle or longhorn sources were modified; no roadmap, milestone, card, or
dispatch status files were touched.
