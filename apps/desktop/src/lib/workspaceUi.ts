import { invoke } from "@tauri-apps/api/core";

export type WorkspacePanelDto = {
  id: string;
  kind: string;
  title: string;
  closeable: boolean;
  movable: boolean;
  allowed_regions: RegionKey[];
};

export type RegionKey = "left" | "right" | "center_top" | "center_bottom";

export type WorkspaceRegionsDto = {
  [key in RegionKey]: WorkspacePanelDto[];
};

export type WorkspaceSurfaceDto = {
  id: string;
  title: string;
  kind: string;
  layout: WorkspaceSurfaceLayoutDto;
  regions: WorkspaceRegionsDto;
};

export type WorkspaceSurfaceLayoutDto = {
  left_center_ratio: number;
  center_right_ratio: number;
  center_stack_ratio: number;
};

export type WorkspaceUiConfigDto = {
  schema_version: number;
  active_surface_id: string;
  surfaces: WorkspaceSurfaceDto[];
};

export async function loadWorkspaceUiConfig(): Promise<WorkspaceUiConfigDto> {
  return invoke<WorkspaceUiConfigDto>("load_workspace_ui_config");
}

export async function saveWorkspaceUiConfig(
  config: WorkspaceUiConfigDto,
): Promise<WorkspaceUiConfigDto> {
  return invoke<WorkspaceUiConfigDto>("save_workspace_ui_config", { config });
}

export function createWorkspaceSurface(index: number): WorkspaceSurfaceDto {
  const safeIndex = Math.max(1, index);
  const id = `surface:user:${Date.now()}`;

  return {
    id,
    title: `Surface ${safeIndex}`,
    kind: "workspace",
    layout: defaultWorkspaceSurfaceLayout(),
    regions: {
      left: [],
      right: [panel(`${id}:panel:context`, "context", "Context", true, true)],
      center_top: [
        panel(`${id}:panel:agentChat`, "agentChat", "Agent Chat", true, true),
        panel(`${id}:panel:tasks`, "tasks", "Tasks", false, true),
      ],
      center_bottom: [panel(`${id}:panel:terminal`, "terminal", "Terminal", true, true)],
    },
  };
}

export function createWorkspacePanel(
  surfaceId: string,
  kind: string,
  index: number,
): WorkspacePanelDto {
  const label = panelLabelForKind(kind);
  const safeIndex = Math.max(1, index);
  const uniqueId = `${surfaceId}:panel:${kind}:${Date.now()}:${safeIndex}`;

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
    case "context":
      return "right";
    case "activity":
    case "projectActivity":
      return "left";
    default:
      return "center_top";
  }
}

export function defaultWorkspaceSurfaceLayout(): WorkspaceSurfaceLayoutDto {
  return {
    left_center_ratio: 0.2,
    center_right_ratio: 0.74,
    center_stack_ratio: 0.74,
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
    allowed_regions: allowedRegionsForKind(kind),
  };
}

function allowedRegionsForKind(kind: string): RegionKey[] {
  switch (kind) {
    case "agentChat":
    case "tasks":
    case "terminal":
    case "browser":
    case "editor":
    case "diff":
      return ["center_top", "center_bottom"];
    case "context":
      return ["right"];
    case "activity":
    case "projectActivity":
      return ["left"];
    default:
      return ["left", "right", "center_top", "center_bottom"];
  }
}

function panelLabelForKind(kind: string): string {
  switch (kind) {
    case "agentChat":
      return "Agent Chat";
    case "terminal":
      return "Terminal";
    case "browser":
      return "Browser";
    case "editor":
      return "Editor";
    case "diff":
      return "Diff";
    case "context":
      return "Context";
    default:
      return "Panel";
  }
}
