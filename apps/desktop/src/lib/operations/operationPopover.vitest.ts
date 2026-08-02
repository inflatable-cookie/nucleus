import { cleanup, render } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

import OperationPopover from "./OperationPopover.svelte";

afterEach(() => cleanup());

function session(active: unknown[] = [], recent: unknown[] = []) {
  return {
    status: { kind: "ready" },
    active,
    recent,
    selectedOperationId: undefined,
    selected: undefined,
    commandRejection: undefined,
    commandFailure: undefined,
    pendingCommands: [],
    select: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    isCancellationPending: () => false,
    isDismissalPending: () => false,
  };
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    authority: { authorityId: "nucleus:desktop-operations", epoch: 1 },
    operationId: "operation:nucleus:1",
    kindId: "nucleus:forge-inspection",
    scopeId: "project:nucleus-local",
    label: "Inspect Forge working copies",
    cancellationSupport: "unsupported",
    retryOf: null,
    sequence: 1,
    revision: 0,
    lastChangedCatalogueRevision: 1,
    state: "running",
    progress: { sequence: 0, overall: { kind: "indeterminate" }, phase: null },
    encodedMetadataWeight: 128,
    ...overrides,
  };
}

test("keeps shell chrome quiet until work exists", () => {
  const screen = render(OperationPopover, { props: { session: session() as never } });
  expect(screen.queryByRole("button", { name: "Background operations" })).toBeNull();
});

test("exposes active and retained host work without product evidence", async () => {
  const screen = render(OperationPopover, {
    props: { session: session([operation()]) as never },
  });
  const trigger = screen.getByRole("button", { name: "Background operations" });
  await trigger.click();
  expect(await screen.findByText("Inspect Forge working copies")).toBeTruthy();
  expect(screen.getByText("Running")).toBeTruthy();
  expect(screen.queryByText(/fingerprint|receipt|path/i)).toBeNull();
});
