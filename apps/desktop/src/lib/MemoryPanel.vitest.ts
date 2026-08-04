import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

const memoryQueries = vi.hoisted(() => ({
  accepted: vi.fn(),
  proposed: vi.fn(),
}));

vi.mock("./control", async (importOriginal) => {
  const original = await importOriginal<typeof import("./control")>();
  return {
    ...original,
    queryAcceptedMemory: memoryQueries.accepted,
    queryMemoryProposals: memoryQueries.proposed,
  };
});

import MemoryPanel from "./MemoryPanel.svelte";

describe("MemoryPanel", () => {
  it("leads with safe project context and keeps technical evidence behind details", async () => {
    memoryQueries.accepted.mockResolvedValue({
      state: "records",
      memories: [
        {
          memory_id: "memory:accepted:one",
          source_proposal_id: "memory:proposal:source",
          display_title: "Use server-owned memory",
          display_summary: "Keep shared project context behind the server boundary.",
          display_redacted: false,
          display_truncated: false,
          scope: "project",
          kind: "decision",
          status: "accepted",
          sensitivity: "internal_project",
          retention: "project_lifetime",
          confidence: "high",
          created_by_ref: "actor:agent",
          accepted_by_ref: "actor:operator",
          reviewer_ref: "actor:reviewer",
          source_ref_count: 1,
          link_ref_count: 2,
          evidence_ref_count: 3,
          supersedes_count: 0,
          superseded_by_count: 0,
        },
      ],
    });
    memoryQueries.proposed.mockResolvedValue({
      state: "records",
      proposals: [
        {
          proposal_id: "memory:proposal:restricted",
          display_title: null,
          display_summary: null,
          display_redacted: true,
          display_truncated: false,
          scope: "project",
          kind: "constraint",
          status: "proposed",
          review_status: "awaiting_review",
          sensitivity: "restricted",
          retention: "project_lifetime",
          source_ref_count: 1,
          link_ref_count: 0,
          supersedes_count: 0,
          superseded_by_count: 0,
        },
      ],
    });

    const screen = render(MemoryPanel, { props: { projectId: "project:one" } });

    expect(await screen.findByRole("heading", { name: "Use server-owned memory" })).toBeTruthy();
    expect(screen.getByText("Keep shared project context behind the server boundary.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Restricted proposal" })).toBeTruthy();
    expect(screen.getByText("Content is unavailable at this sensitivity.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Memory" })).toBeNull();

    const details = screen.container.querySelector("details") as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    await fireEvent.click(details!.querySelector("summary")!);
    expect(details!.open).toBe(true);
    expect(screen.getByText("memory:accepted:one")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Refresh project memory" }));
    await waitFor(() => {
      expect(memoryQueries.accepted).toHaveBeenCalledTimes(2);
      expect(memoryQueries.proposed).toHaveBeenCalledTimes(2);
    });
    screen.unmount();
  });

  it("replaces project-scoped content when the selected project changes", async () => {
    memoryQueries.accepted.mockImplementation(async (projectId: string) => ({
      state: "records",
      memories: [{
        memory_id: `memory:${projectId}`,
        source_proposal_id: null,
        display_title: `Memory for ${projectId}`,
        display_summary: "Project-scoped context",
        display_redacted: false,
        display_truncated: false,
        scope: "project",
        kind: "decision",
        status: "accepted",
        sensitivity: "internal_project",
        retention: "project_lifetime",
        confidence: "high",
        created_by_ref: "actor:agent",
        accepted_by_ref: "actor:operator",
        reviewer_ref: "actor:operator",
        source_ref_count: 0,
        link_ref_count: 0,
        evidence_ref_count: 0,
        supersedes_count: 0,
        superseded_by_count: 0,
      }],
    }));
    memoryQueries.proposed.mockResolvedValue({ state: "empty" });

    const screen = render(MemoryPanel, { props: { projectId: "one" } });
    expect(await screen.findByRole("heading", { name: "Memory for one" })).toBeTruthy();

    await screen.rerender({ projectId: "two" });
    expect(await screen.findByRole("heading", { name: "Memory for two" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Memory for one" })).toBeNull();
    screen.unmount();
  });
});
