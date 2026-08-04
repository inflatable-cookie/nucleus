import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  projectLoadFailuresRemaining: 0,
  projects: [
    {
      project_id: "project:one",
      display_name: "First project",
      authority_host_ref: "host:embedded-desktop",
      status: "active",
      retention: "durable",
      importance_level: "normal",
      revision_id: "revision:one",
      resource_count: 0,
      repository_count: 0,
      default_working_resource_id: null,
      management_resource_id: null,
      management_sync_policy: null,
      management_projection_status: null,
      location_status: "available",
      resources: [],
    },
    {
      project_id: "project:two",
      display_name: "Second project",
      authority_host_ref: "host:embedded-desktop",
      status: "active",
      retention: "durable",
      importance_level: "normal",
      revision_id: "revision:two",
      resource_count: 0,
      repository_count: 0,
      default_working_resource_id: null,
      management_resource_id: null,
      management_sync_policy: null,
      management_projection_status: null,
      location_status: "available",
      resources: [],
    },
  ],
}));

vi.mock("./control", () => ({
  buildControlCommandEnvelope: vi.fn((command) => command),
  buildStateListQuery: vi.fn((domain) => domain),
  projectRecordsFromResponse: vi.fn(() => fixtures.projects),
  submitControlEnvelope: vi.fn(async (request: unknown) => {
    if (request === "projects" && fixtures.projectLoadFailuresRemaining > 0) {
      fixtures.projectLoadFailuresRemaining -= 1;
      throw new Error("Project catalogue unavailable");
    }
    return { body: { type: "project_records", records: fixtures.projects } };
  }),
}));

vi.mock("./control/agentChat", () => ({
  listAgentChatThreads: vi.fn(async () => []),
}));

import ProjectRail from "./ProjectRail.svelte";

afterEach(() => {
  fixtures.projectLoadFailuresRemaining = 0;
  cleanup();
});

describe("ProjectRail semantic project interaction", () => {
  it("selects with a native button and keeps inline rename reachable by menu", async () => {
    const screen = render(ProjectRail, {
      props: {
        selectedProjectId: "project:one",
        selectedProject: null,
        selectedConversationId: null,
      },
    });

    const secondProject = await screen.findByRole("button", { name: "Second project" });
    await fireEvent.click(secondProject);
    expect(secondProject.getAttribute("aria-current")).toBe("true");

    await fireEvent.click(screen.getByRole("button", { name: "Project actions for Second project" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("retains double-click as a pointer convenience for the same inline field", async () => {
    const screen = render(ProjectRail, {
      props: {
        selectedProjectId: "project:one",
        selectedProject: null,
        selectedConversationId: null,
      },
    });

    const secondProject = await screen.findByRole("button", { name: "Second project" });
    await fireEvent.dblClick(secondProject);
    const input = await screen.findByRole("textbox", { name: "Project name" });
    expect((input as HTMLInputElement).value).toBe("Second project");
  });

  it("announces a failed project read and retries the exact local query", async () => {
    fixtures.projectLoadFailuresRemaining = 1;
    const screen = render(ProjectRail, {
      props: {
        selectedProjectId: null,
        selectedProject: null,
        selectedConversationId: null,
      },
    });

    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("Project catalogue unavailable");
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Second project" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Project catalogue unavailable")).toBeNull());
  });
});
