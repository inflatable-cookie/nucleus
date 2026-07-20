import { invoke } from "@tauri-apps/api/core";

export type WorkspacePanelDto = {
  id: string;
  kind: string;
  title: string;
  closeable: boolean;
  movable: boolean;
  resource_targets: Record<string, string>;
  allowed_regions: RegionKey[];
};

export type RegionKey =
  | "left"
  | "center_top"
  | "center_bottom"
  | "right_top"
  | "right_bottom";

export type WorkspaceRegionsDto = {
  [key in RegionKey]: WorkspacePanelDto[];
};

export type WorkspaceWindowDto = {
  id: string;
  placement: WorkspaceWindowPlacementDto;
  layout: WorkspaceLayoutDto;
  regions: WorkspaceRegionsDto;
  active_panels: Partial<Record<RegionKey, string>>;
};

export type WorkspaceWindowPlacementDto = {
  display_id?: string;
  normal_bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  maximized: boolean;
};

export type WorkspaceLayoutDto = {
  left_center_ratio: number;
  center_right_ratio: number;
  center_stack_ratio: number;
  right_stack_ratio: number;
};

export type WorkspaceUiConfigDto = {
  schema_version: number;
  window: WorkspaceWindowDto;
};

const EMPTY_WORKSPACE_PANEL: WorkspacePanelDto = {
  id: "panel:none",
  kind: "empty",
  title: "Empty panel",
  closeable: false,
  movable: false,
  resource_targets: {},
  allowed_regions: [],
};

export async function loadWorkspaceUiConfig(projectId: string): Promise<WorkspaceUiConfigDto> {
  return invoke<WorkspaceUiConfigDto>("load_workspace_ui_config", { projectId });
}

export async function saveWorkspaceUiConfig(
  projectId: string,
  config: WorkspaceUiConfigDto,
): Promise<WorkspaceUiConfigDto> {
  return invoke<WorkspaceUiConfigDto>("save_workspace_ui_config", { projectId, config });
}

export function workspaceWindowForProject(
  config: WorkspaceUiConfigDto | null,
  configProjectId: string | null,
  selectedProjectId: string | null,
): WorkspaceWindowDto | null {
  return config && configProjectId && configProjectId === selectedProjectId
    ? config.window
    : null;
}

export function workspacePanelFor(
  panels: WorkspacePanelDto[],
  activePanelId: string | null,
): WorkspacePanelDto {
  return panels.find((panel) => panel.id === activePanelId)
    ?? panels[0]
    ?? EMPTY_WORKSPACE_PANEL;
}

export function createWorkspacePanel(
  windowId: string,
  kind: string,
  index: number,
): WorkspacePanelDto {
  const label = panelLabelForKind(kind);
  const safeIndex = Math.max(1, index);
  const uniqueId = `${windowId}:panel:${kind}:${Date.now()}:${safeIndex}`;

  return panel(
    uniqueId,
    kind,
    safeIndex === 1 ? label : `${label} ${safeIndex}`,
    true,
    true,
  );
}

export function defaultRegionForPanelKind(kind: string): RegionKey {
  switch (kind) {
    case "memory":
      return "right_top";
    case "activity":
    case "projectActivity":
      return "left";
    default:
      return "center_top";
  }
}

export function defaultWorkspaceLayout(): WorkspaceLayoutDto {
  return {
    left_center_ratio: 0.2,
    center_right_ratio: 0.74,
    center_stack_ratio: 0.74,
    right_stack_ratio: 0.74,
  };
}

function panel(
  id: string,
  kind: string,
  title: string,
  closeable: boolean,
  movable: boolean,
): WorkspacePanelDto {
  return {
    id,
    kind,
    title,
    closeable,
    movable,
    resource_targets: {},
    allowed_regions: allowedRegionsForKind(kind),
  };
}

function allowedRegionsForKind(kind: string): RegionKey[] {
  switch (kind) {
    case "activity":
    case "projectActivity":
      return ["left"];
    default:
      return ["center_top", "center_bottom", "right_top", "right_bottom"];
  }
}

function panelLabelForKind(kind: string): string {
  switch (kind) {
    case "agentChat":
      return "Agent Chat";
    case "tasks":
      return "Tasks";
    case "terminal":
      return "Terminal";
    case "browser":
      return "Browser";
    case "editor":
      return "Editor";
    case "diff":
      return "Diff";
    case "memory":
      return "Memory";
    default:
      return "Panel";
  }
}
