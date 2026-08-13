import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fleetPanelRuns } from "./runFleetPanel.fixture";

const queryOrchestrationRuns = vi.hoisted(() => vi.fn());

vi.mock("./control/runFleet", () => ({
  queryOrchestrationRuns,
}));

import RunFleetPanel from "./RunFleetPanel.svelte";

afterEach(() => cleanup());

beforeEach(() => {
  queryOrchestrationRuns.mockReset();
  queryOrchestrationRuns.mockResolvedValue({
    state: "record",
    project_id: "project:one",
    runs: fleetPanelRuns,
    state_counts: [
      { state: "running", count: 1 },
      { state: "delivered", count: 1 },
      { state: "failed", count: 1 },
    ],
  });
});

describe("RunFleetPanel", () => {
  it("groups lifecycle states and preserves failed-run truth", async () => {
    const screen = render(RunFleetPanel, {
      props: { selectedProjectId: "project:one", onOpenRun: vi.fn() },
    });

    expect(await screen.findByRole("heading", { name: "Active" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Delivered" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeTruthy();
    expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Failure receipt recorded; open the worker thread for its reason.")).toBeTruthy();
    expect(screen.getAllByText("Budget burn not reported")).toHaveLength(3);
  });

  it("opens the selected run through the host callback", async () => {
    const onOpenRun = vi.fn();
    const screen = render(RunFleetPanel, {
      props: { selectedProjectId: "project:one", onOpenRun },
    });

    await fireEvent.click(await screen.findByRole("button", { name: "Open run delivered-worker" }));
    expect(onOpenRun).toHaveBeenCalledWith(fleetPanelRuns[1]);
  });

  it("renders the no-project boundary without querying", () => {
    const screen = render(RunFleetPanel, {
      props: { selectedProjectId: null, onOpenRun: vi.fn() },
    });

    expect(screen.getByText("Select a project to view its runs.")).toBeTruthy();
    expect(queryOrchestrationRuns).not.toHaveBeenCalled();
  });
});
