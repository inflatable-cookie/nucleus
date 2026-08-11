import { cleanup, fireEvent, render } from "@testing-library/svelte";
import type { RenderResult } from "@testing-library/svelte";
import type { Component } from "@testing-library/svelte-core/types";
import { afterEach, expect, test, vi } from "vitest";
import { ToastHost } from "@inflatable-cookie/poodle-svelte";

import NotificationPopover from "./NotificationPopover.svelte";
import {
  createNotificationToastStore,
  executeNotificationToastAction,
} from "./toastHost";
import {
  nucleusNotificationActionExecutor,
  shouldToastNotification,
} from "./runtime.svelte";

afterEach(() => cleanup());

function draft(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "nucleus:operations",
    severity: "error",
    title: "Commit Forge changes failed",
    summary: "Background work stopped without success.",
    causeId: "operation:nucleus:1",
    actions: [{ referenceId: "nucleus:sidebar.show-forge", label: "Open Forge" }],
    replacementKey: null,
    producerToken: null,
    retentionClass: "standard",
    presentationTimeUnixMs: null,
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: "notification:nucleus:1",
    sequence: 1,
    readState: "unseen",
    lastChangedLedgerRevision: 1,
    encodedMetadataWeight: 128,
    draft: draft(),
    ...overrides,
  };
}

function toast(overrides: Record<string, unknown> = {}) {
  return {
    id: "toast:nucleus:1",
    notificationId: "notification:nucleus:1",
    title: "Commit Forge changes failed",
    description: "Background work stopped without success.",
    tone: "danger",
    ...overrides,
  };
}

function session(records: unknown[] = [], toasts: unknown[] = []) {
  return {
    status: { kind: "ready" },
    snapshot: {
      retainedCount: records.length,
      unseenCount: records.length,
    },
    records,
    toasts,
    selectedNotificationId: undefined,
    selected: undefined,
    commandRejection: undefined,
    commandFailure: undefined,
    hasMore: false,
    select: vi.fn(),
    markSeen: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    dismissToast: vi.fn(),
    invokeAction: vi.fn().mockResolvedValue(undefined),
    isPending: () => false,
    observe: vi.fn(() => () => undefined),
  };
}

async function openArchive(screen: RenderResult<Component>) {
  await fireEvent.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
  return screen.findByText("Commit Forge changes failed");
}

test("message centre trigger derives unread count and opens the archive", async () => {
  const empty = render(NotificationPopover, { props: { session: session() as never } });
  expect(empty.getByRole("button", { name: "Notifications" })).toBeTruthy();
  empty.unmount();

  const screen = render(NotificationPopover, { props: { session: session([record()]) as never } });
  await openArchive(screen);
  expect(screen.getByText("Background work stopped without success.")).toBeTruthy();
  expect(screen.getByText("nucleus:operations")).toBeTruthy();
});

test("archive read/remove/mark-all callbacks mutate the ledger session", async () => {
  const s = session([
    record(),
    record({
      notificationId: "notification:nucleus:2",
      readState: "seen",
      draft: draft({ title: "Build succeeded" }),
    }),
  ]);
  const screen = render(NotificationPopover, { props: { session: s as never } });
  await openArchive(screen);

  await fireEvent.click(screen.getByRole("button", { name: "Mark Commit Forge changes failed read" }));
  expect(s.markSeen).toHaveBeenCalledWith("notification:nucleus:1");

  await fireEvent.click(screen.getByRole("button", { name: "Remove Commit Forge changes failed" }));
  expect(s.dismiss).toHaveBeenCalledWith("notification:nucleus:1");

  await fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  // Only the still-unseen record is marked; the seen one is not revisited.
  expect(s.markSeen).toHaveBeenCalledTimes(2);
  expect(s.markSeen).toHaveBeenLastCalledWith("notification:nucleus:1");
});

test("selecting an archive row selects and runs admitted actions only", async () => {
  const s = session([record()]);
  const screen = render(NotificationPopover, { props: { session: s as never } });
  await openArchive(screen);

  await fireEvent.click(screen.getByRole("button", { name: "Commit Forge changes failed" }));
  expect(s.select).toHaveBeenCalledWith("notification:nucleus:1");
  expect(s.invokeAction).toHaveBeenCalledWith("notification:nucleus:1", "nucleus:sidebar.show-forge");
  screen.unmount();

  const untrusted = session([
    record({ draft: draft({ actions: [{ referenceId: "nucleus:untrusted", label: "Nope" }] }) }),
  ]);
  const untrustedScreen = render(NotificationPopover, { props: { session: untrusted as never } });
  await openArchive(untrustedScreen);

  await fireEvent.click(untrustedScreen.getByRole("button", { name: "Commit Forge changes failed" }));
  expect(untrusted.select).toHaveBeenCalledWith("notification:nucleus:1");
  expect(untrusted.invokeAction).not.toHaveBeenCalled();
});

test("toast surface renders session toasts; dismiss never touches the archive", async () => {
  const s = session([record()], [toast()]);
  const host = render(ToastHost, {
    props: { store: createNotificationToastStore(s as never), autoDismissMs: 0 },
  });

  expect(host.getByText("Commit Forge changes failed")).toBeTruthy();
  expect(host.getByText("Background work stopped without success.")).toBeTruthy();

  await fireEvent.click(host.getByRole("button", { name: "Dismiss Commit Forge changes failed" }));
  expect(s.dismissToast).toHaveBeenCalledWith("toast:nucleus:1");
  expect(s.dismiss).not.toHaveBeenCalled();
});

test("toast action requests run through the session executor", async () => {
  const s = session([], [
    toast({ action: { referenceId: "nucleus:sidebar.show-forge", label: "Open Forge" } }),
  ]);
  const host = render(ToastHost, {
    props: {
      store: createNotificationToastStore(s as never),
      autoDismissMs: 0,
      onAction: (id: string) => executeNotificationToastAction(s as never, id),
    },
  });

  await fireEvent.click(host.getByRole("button", { name: "Open Forge" }));
  expect(s.invokeAction).toHaveBeenCalledWith("notification:nucleus:1", "nucleus:sidebar.show-forge");
});

test("only attention severities become transient toasts", () => {
  expect(shouldToastNotification(record() as never)).toBe(true);
  expect(shouldToastNotification(record({ draft: { severity: "success" } }) as never)).toBe(false);
  expect(shouldToastNotification(record({ draft: { severity: "info" } }) as never)).toBe(false);
});

test("semantic actions rerun command admission and reject unknown references", async () => {
  const select = vi.fn().mockResolvedValue({ status: "succeeded" });
  const executor = nucleusNotificationActionExecutor({ select } as never);
  await executor.admitAndExecute({
    notificationId: "notification:nucleus:1",
    sourceId: "nucleus:operations",
    referenceId: "nucleus:sidebar.show-forge",
  });
  expect(select).toHaveBeenCalledWith("nucleus:sidebar.show-forge");
  await expect(executor.admitAndExecute({
    notificationId: "notification:nucleus:1",
    sourceId: "nucleus:operations",
    referenceId: "nucleus:untrusted",
  })).rejects.toThrow("not admitted");
});
