import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckedSnapshotConnection,
  type ConnectionFailureReporter,
} from "@inflatable-cookie/longhorn/core";
import {
  assertValidLayoutMutationCommand,
  assertValidLayoutMutationOutcome,
  assertValidLayoutMutationRejectionCode,
  type LayoutDocument,
  type LayoutMutationRequest,
  type LayoutSchemaDefinition,
  type PanelDefinition,
} from "@inflatable-cookie/longhorn/layout";
import type { LayoutDispatchResult } from "@inflatable-cookie/longhorn-poodle-svelte/layout";

export const WORKSPACE_LAYOUT_CHANGED_EVENT = "nucleus://workspace-layout";

export type WorkspaceEditorFile = {
  resource_id: string | null;
  file_ref: string;
  display_path: string | null;
};

export type WorkspaceForgeDiff = {
  resource_id: string;
  path: string;
  scope: "all" | "staged" | "working";
};

export type WorkspacePanelPresentationInput = {
  external_id: string;
  kind: string;
  title: string;
  resource_targets: Record<string, string>;
  editor_file: WorkspaceEditorFile | null;
  forge_diff: WorkspaceForgeDiff | null;
  conversation_id: string | null;
};

export type WorkspacePanelPresentation = WorkspacePanelPresentationInput & {
  panel_instance_id: string;
};

export type WorkspaceProjectContext = {
  selected_goal_id: string | null;
  selected_task_id: string | null;
  active_conversation_id: string | null;
};

export type WorkspaceLayoutSnapshot = {
  projection_revision: number;
  project_id: string;
  container_id: string;
  document: LayoutDocument;
  schemas: LayoutSchemaDefinition[];
  panel_definitions: PanelDefinition[];
  panels: WorkspacePanelPresentation[];
  context: WorkspaceProjectContext;
};

export type WorkspacePreparedPanel = {
  panel_instance_id: string;
  panel_definition_id: string;
  region_id: string;
  presentation: WorkspacePanelPresentationInput;
};

export type WorkspaceLayoutMutationResponse = {
  result: LayoutDispatchResult;
  snapshot: WorkspaceLayoutSnapshot;
};

export function connectWorkspaceLayout(
  projectId: string,
  listener: (snapshot: WorkspaceLayoutSnapshot) => void,
  onFailure?: ConnectionFailureReporter,
): CheckedSnapshotConnection<WorkspaceLayoutSnapshot> {
  return new CheckedSnapshotConnection({
    listen: async (receive) => {
      const unlisten = await listen<unknown>(
        WORKSPACE_LAYOUT_CHANGED_EVENT,
        ({ payload }) => receive(payload),
      );
      return unlisten;
    },
    loadSnapshot: () =>
      invoke("workspace_layout_snapshot", { projectId }),
    validateSnapshot: validateWorkspaceLayoutSnapshot,
    handleEvent: (payload) => {
      const snapshot = validateWorkspaceLayoutSnapshot(payload);
      return snapshot.project_id === projectId
        ? { kind: "snapshot", value: snapshot }
        : { kind: "ignore" };
    },
    isNewer: (candidate, current) =>
      current === undefined ||
      candidate.projection_revision > current.projection_revision,
    onSnapshot: listener,
    onFailure,
  });
}

export async function prepareWorkspacePanel(
  projectId: string,
  presentation: WorkspacePanelPresentationInput,
): Promise<WorkspacePreparedPanel> {
  return validatePreparedPanel(
    await invoke("prepare_workspace_panel", { projectId, presentation }),
  );
}

export async function mutateWorkspaceLayout(
  projectId: string,
  request: LayoutMutationRequest,
  createPanel: WorkspacePanelPresentationInput | null = null,
): Promise<WorkspaceLayoutMutationResponse> {
  assertValidLayoutMutationCommand(request.command);
  return validateMutationResponse(
    await invoke("mutate_workspace_layout", {
      projectId,
      mutation: { request, create_panel: createPanel },
    }),
  );
}

export async function updateWorkspacePanelPresentation(
  projectId: string,
  panelInstanceId: string,
  presentation: WorkspacePanelPresentationInput,
): Promise<WorkspaceLayoutSnapshot> {
  return validateWorkspaceLayoutSnapshot(
    await invoke("update_workspace_panel_presentation", {
      projectId,
      panelInstanceId,
      presentation,
    }),
  );
}

export async function updateWorkspaceProjectContext(
  projectId: string,
  context: WorkspaceProjectContext,
): Promise<WorkspaceLayoutSnapshot> {
  return validateWorkspaceLayoutSnapshot(
    await invoke("update_workspace_project_context", { projectId, context }),
  );
}

export function validateWorkspaceLayoutSnapshot(
  value: unknown,
): WorkspaceLayoutSnapshot {
  const record = object(value, "workspace layout snapshot");
  integer(record.projection_revision, "projection_revision");
  string(record.project_id, "project_id");
  string(record.container_id, "container_id");
  validateLayoutDocument(record.document);
  array(record.schemas, "schemas").forEach(validateLayoutSchema);
  array(record.panel_definitions, "panel_definitions").forEach(
    validatePanelDefinition,
  );
  array(record.panels, "panels").forEach(validatePanelPresentation);
  validateProjectContext(record.context);
  return record as WorkspaceLayoutSnapshot;
}

function validateMutationResponse(value: unknown): WorkspaceLayoutMutationResponse {
  const record = object(value, "workspace layout mutation response");
  const result = object(record.result, "layout dispatch result");
  if (result.status === "committed") {
    const receipt = object(result.receipt, "layout mutation receipt");
    string(receipt.request_id, "request_id");
    integer(receipt.previous_revision, "previous_revision");
    integer(receipt.committed_revision, "committed_revision");
    assertValidLayoutMutationOutcome(receipt.outcome);
    validateLayoutDocument(receipt.authoritative_document);
  } else if (result.status === "rejected") {
    const rejection = object(result.rejection, "layout mutation rejection");
    string(rejection.request_id, "request_id");
    integer(rejection.current_revision, "current_revision");
    assertValidLayoutMutationRejectionCode(rejection.code);
    string(rejection.detail, "detail");
    validateLayoutDocument(rejection.authoritative_document);
  } else {
    throw new TypeError("layout dispatch result has an unknown status");
  }
  validateWorkspaceLayoutSnapshot(record.snapshot);
  return record as WorkspaceLayoutMutationResponse;
}

function validatePreparedPanel(value: unknown): WorkspacePreparedPanel {
  const record = object(value, "prepared workspace panel");
  string(record.panel_instance_id, "panel_instance_id");
  string(record.panel_definition_id, "panel_definition_id");
  string(record.region_id, "region_id");
  validatePanelPresentationInput(record.presentation);
  return record as WorkspacePreparedPanel;
}

function validateProjectContext(value: unknown): void {
  const record = object(value, "workspace project context");
  nullableString(record.selected_goal_id, "selected_goal_id");
  nullableString(record.selected_task_id, "selected_task_id");
  nullableString(record.active_conversation_id, "active_conversation_id");
}

function validateLayoutDocument(value: unknown): asserts value is LayoutDocument {
  const document = object(value, "layout document");
  integer(document.revision, "revision");
  array(document.containers, "containers").forEach((candidate) => {
    const container = object(candidate, "layout container");
    string(container.id, "container.id");
    string(container.schema_id, "container.schema_id");
    array(container.regions, "container.regions").forEach((regionValue) => {
      const region = object(regionValue, "region state");
      string(region.region_id, "region_id");
      array(region.panel_instance_ids, "panel_instance_ids").forEach((id) =>
        string(id, "panel_instance_id"),
      );
      nullableString(region.active_panel_instance_id, "active_panel_instance_id");
      nullableBoolean(region.collapsed, "collapsed");
    });
    array(container.sizing_slots, "container.sizing_slots").forEach((slotValue) => {
      const slot = object(slotValue, "sizing slot state");
      string(slot.sizing_slot_id, "sizing_slot_id");
      integer(slot.ratio, "ratio");
    });
  });
  array(document.panel_instances, "panel_instances").forEach((instanceValue) => {
    const instance = object(instanceValue, "panel instance");
    string(instance.id, "panel instance id");
    string(instance.definition_id, "panel definition id");
  });
}

function validateLayoutSchema(value: unknown): void {
  const schema = object(value, "layout schema");
  string(schema.id, "schema id");
  array(schema.regions, "schema regions").forEach((regionValue) => {
    const region = object(regionValue, "region definition");
    string(region.id, "region id");
    string(region.family_id, "region family id");
    integer(region.order, "region order");
    if (region.empty_policy !== "keep_visible" && region.empty_policy !== "hide_when_empty") {
      throw new TypeError("region definition has an unknown empty policy");
    }
    boolean(region.collapsible, "region collapsible");
  });
  array(schema.sizing_slots, "schema sizing slots").forEach((slotValue) => {
    const slot = object(slotValue, "sizing slot definition");
    string(slot.id, "sizing slot id");
    integer(slot.order, "sizing slot order");
    integer(slot.minimum, "sizing slot minimum");
    integer(slot.default, "sizing slot default");
    integer(slot.maximum, "sizing slot maximum");
  });
}

function validatePanelDefinition(value: unknown): void {
  const definition = object(value, "panel definition");
  string(definition.id, "panel definition id");
  array(definition.default_placements, "default placements").forEach(validatePlacement);
  array(definition.allowed_placements, "allowed placements").forEach(validatePlacement);
  const policy = object(definition.instance_policy, "panel instance policy");
  if (!["singleton", "one_per_container", "bounded", "multiple"].includes(String(policy.kind))) {
    throw new TypeError("panel definition has an unknown instance policy");
  }
  if (policy.kind === "bounded") {
    integer(policy.maximum_per_document, "maximum_per_document");
    integer(policy.maximum_per_container, "maximum_per_container");
  }
  boolean(definition.movable, "panel movable");
  boolean(definition.closeable, "panel closeable");
}

function validatePlacement(value: unknown): void {
  const placement = object(value, "placement selector");
  if (placement.kind !== "region" && placement.kind !== "family") {
    throw new TypeError("placement selector has an unknown kind");
  }
  string(placement.id, "placement selector id");
}

function validatePanelPresentation(value: unknown): void {
  const panel = object(value, "panel presentation");
  string(panel.panel_instance_id, "panel_instance_id");
  validatePanelPresentationInput(panel);
}

function validatePanelPresentationInput(value: unknown): void {
  const panel = object(value, "panel presentation input");
  string(panel.external_id, "external_id");
  string(panel.kind, "kind");
  string(panel.title, "title");
  const targets = object(panel.resource_targets, "resource_targets");
  Object.values(targets).forEach((target) => string(target, "resource target"));
  if (panel.editor_file !== null) {
    const file = object(panel.editor_file, "editor_file");
    nullableString(file.resource_id, "editor resource_id");
    string(file.file_ref, "editor file_ref");
    nullableString(file.display_path, "editor display_path");
  }
  if (panel.forge_diff !== null) {
    const diff = object(panel.forge_diff, "forge_diff");
    string(diff.resource_id, "forge resource_id");
    string(diff.path, "forge path");
    if (!["all", "staged", "working"].includes(String(diff.scope))) {
      throw new TypeError("forge diff has an unknown scope");
    }
  }
  nullableString(panel.conversation_id, "conversation_id");
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function integer(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function boolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
}

function nullableString(value: unknown, name: string): void {
  if (value !== null) string(value, name);
}

function nullableBoolean(value: unknown, name: string): void {
  if (value !== null) boolean(value, name);
}
