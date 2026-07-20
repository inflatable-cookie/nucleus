import { describe, expect, test } from "bun:test";
import {
  workspacePanelFor,
  workspaceWindowForProject,
  type WorkspacePanelDto,
  type WorkspaceUiConfigDto,
} from "./workspaceUi";

const config: WorkspaceUiConfigDto = {
  schema_version: 7,
  window: {
    id: "window:primary",
    placement: { maximized: false },
    layout: {
      left_center_ratio: 0.2,
      center_right_ratio: 0.74,
      center_stack_ratio: 0.74,
      right_stack_ratio: 0.74,
    },
    regions: {
      left: [],
      center_top: [],
      center_bottom: [],
      right_top: [],
      right_bottom: [],
    },
    active_panels: {},
  },
};

describe("workspaceWindowForProject", () => {
  test("exposes a layout only to the project it was loaded for", () => {
    expect(workspaceWindowForProject(config, "project:one", "project:one")).toBe(
      config.window,
    );
    expect(workspaceWindowForProject(config, "project:one", "project:two")).toBeNull();
  });

  test("keeps loading and unselected states out of region rendering", () => {
    expect(workspaceWindowForProject(null, null, "project:one")).toBeNull();
    expect(workspaceWindowForProject(config, null, "project:one")).toBeNull();
    expect(workspaceWindowForProject(config, "project:one", null)).toBeNull();
  });
});

describe("workspacePanelFor", () => {
  const first: WorkspacePanelDto = {
    id: "panel:first",
    kind: "agentChat",
    title: "Agent Chat",
    closeable: true,
    movable: true,
    resource_targets: {},
    allowed_regions: ["center_top"],
  };

  test("uses the selected panel or the first available panel", () => {
    const second = { ...first, id: "panel:second", title: "Tasks" };
    expect(workspacePanelFor([first, second], second.id)).toBe(second);
    expect(workspacePanelFor([first, second], "panel:missing")).toBe(first);
  });

  test("returns a non-null empty panel while a region tears down", () => {
    expect(workspacePanelFor([], null)).toMatchObject({
      id: "panel:none",
      kind: "empty",
    });
  });
});
