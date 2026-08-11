import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  projectLoadFailuresRemaining: 0,
  projectCommandRefusal: false,
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
  ControlCommandRefusalError: class ControlCommandRefusalError extends Error {},
  buildControlCommandEnvelope: vi.fn((command) => command),
  buildStateListQuery: vi.fn((domain) => domain),
  projectRecordsFromResponse: vi.fn(() => fixtures.projects),
  submitControlEnvelope: vi.fn(async (request: unknown) => {
    if (request === "projects" && fixtures.projectLoadFailuresRemaining > 0) {
      fixtures.projectLoadFailuresRemaining -= 1;
      throw new Error("Project catalogue unavailable");
    }
    if (typeof request === "object" && request !== null && "kind" in request
      && request.kind === "project_lifecycle" && fixtures.projectCommandRefusal) {
      return {
        body: {
          type: "command_receipt",
          status: "rejected",
          error_reason: "project deletion refused: retained resources=1, tasks=6",
        },
      };
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
  fixtures.projectCommandRefusal = false;
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

  it("routes a refused project mutation without a permanent rail alert", async () => {
    fixtures.projectCommandRefusal = true;
    const screen = render(ProjectRail, {
      props: {
        selectedProjectId: "project:one",
        selectedProject: null,
        selectedConversationId: null,
      },
    });

    await screen.findByRole("button", { name: "First project" });
    await fireEvent.click(screen.getByRole("button", { name: "Project actions for First project" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
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
