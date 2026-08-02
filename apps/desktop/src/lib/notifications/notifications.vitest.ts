import { cleanup, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

import NotificationPopover from "./NotificationPopover.svelte";
import {
  nucleusNotificationActionExecutor,
  shouldToastNotification,
} from "./runtime.svelte";

afterEach(() => cleanup());

function record(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: "notification:nucleus:1",
    sequence: 1,
    readState: "unseen",
    lastChangedLedgerRevision: 1,
    encodedMetadataWeight: 128,
    draft: {
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
    },
    ...overrides,
  };
}

function session(records: unknown[] = []) {
  return {
    status: { kind: "ready" },
    snapshot: {
      retainedCount: records.length,
      unseenCount: records.length,
    },
    records,
    selectedNotificationId: undefined,
    selected: undefined,
    commandRejection: undefined,
    commandFailure: undefined,
    hasMore: false,
    select: vi.fn(),
    markSeen: vi.fn(),
    dismiss: vi.fn(),
    invokeAction: vi.fn(),
    isPending: () => false,
  };
}

test("notification affordance uses authoritative unseen count and stays absent when empty", async () => {
  const empty = render(NotificationPopover, { props: { session: session() as never } });
  expect(empty.queryByRole("button", { name: /unseen notifications/ })).toBeNull();
  empty.unmount();

  const screen = render(NotificationPopover, { props: { session: session([record()]) as never } });
  const trigger = screen.getByRole("button", { name: "1 unseen notifications" });
  await trigger.click();
  expect(await screen.findByText("Commit Forge changes failed")).toBeTruthy();
  expect(screen.getByText("Background work stopped without success.")).toBeTruthy();
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
