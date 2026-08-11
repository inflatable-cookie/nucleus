import type {
  SurfaceDocument,
  LayoutMutationRequest,
  PanelInstanceId,
} from "@inflatable-cookie/longhorn/layout";
import type {
  PanelPresentation,
  PoodleLayoutBinding,
} from "@inflatable-cookie/longhorn-poodle-svelte/poodle/binding";
import { createPoodleLayoutBinding } from "@inflatable-cookie/longhorn-poodle-svelte/poodle/binding";
import {
  LayoutState,
  type LayoutDispatchResult,
} from "@inflatable-cookie/longhorn-poodle-svelte/layout";
import {
  ReactiveClientState,
  type ClientStatus,
  type ReactiveConnection,
} from "@inflatable-cookie/longhorn-poodle-svelte";
import type { ConnectionFailureReporter } from "@inflatable-cookie/longhorn/core";

import {
  connectWorkspaceLayout,
  mutateWorkspaceLayout,
  prepareWorkspacePanel,
  updateWorkspacePanelPresentation,
  updateWorkspaceProjectContext,
  type WorkspaceLayoutSnapshot,
  type WorkspacePanelPresentation,
  type WorkspacePanelPresentationInput,
  type WorkspaceProjectContext,
} from "./workspaceLayout";

export interface WorkspaceLayoutSessionOptions {
  readonly projectId: string;
  readonly onPanelClosed?: (panel: WorkspacePanelPresentation) => void;
  readonly port?: WorkspaceLayoutPort;
}

export interface WorkspaceLayoutPort {
  connect(
    projectId: string,
    listener: (snapshot: WorkspaceLayoutSnapshot) => void,
    onFailure: ConnectionFailureReporter,
  ): ReactiveConnection<WorkspaceLayoutSnapshot>;
  prepare(
    projectId: string,
    presentation: WorkspacePanelPresentationInput,
  ): ReturnType<typeof prepareWorkspacePanel>;
  mutate(
    projectId: string,
    request: LayoutMutationRequest,
    createPanel: WorkspacePanelPresentationInput | null,
  ): ReturnType<typeof mutateWorkspaceLayout>;
  update(
    projectId: string,
    panelInstanceId: string,
    presentation: WorkspacePanelPresentationInput,
  ): ReturnType<typeof updateWorkspacePanelPresentation>;
  updateContext(
    projectId: string,
    context: WorkspaceProjectContext,
  ): ReturnType<typeof updateWorkspaceProjectContext>;
}

const workspaceLayoutPort: WorkspaceLayoutPort = {
  connect: connectWorkspaceLayout,
  prepare: prepareWorkspacePanel,
  mutate: mutateWorkspaceLayout,
  update: updateWorkspacePanelPresentation,
  updateContext: updateWorkspaceProjectContext,
};

export class WorkspaceLayoutSession {
  readonly projectId: string;
  readonly layout: LayoutState;
  readonly #options: WorkspaceLayoutSessionOptions;
  readonly #port: WorkspaceLayoutPort;
  readonly #lifecycle: ReactiveClientState<WorkspaceLayoutSnapshot>;
  readonly #clientEpoch = createClientEpoch();
  readonly #pendingCreates = new Map<string, WorkspacePanelPresentationInput>();
  #snapshot = $state.raw<WorkspaceLayoutSnapshot | undefined>(undefined);
  #binding = $state.raw<PoodleLayoutBinding | undefined>(undefined);
  #error = $state.raw<unknown>(undefined);
  #generation = 0;
  #requestSequence = 0;
  #destroyed = false;

  constructor(options: WorkspaceLayoutSessionOptions) {
    this.#options = options;
    this.#port = options.port ?? workspaceLayoutPort;
    this.projectId = options.projectId;
    this.layout = new LayoutState({
      dispatch: (request) => this.#dispatch(request),
    });
    this.#lifecycle = new ReactiveClientState({
      capability: {
        kind: "supported",
        connect: (listener, onFailure) =>
          this.#port.connect(this.projectId, listener, onFailure),
      },
      onSnapshot: (snapshot) => this.#accept(snapshot),
      onFailure: ({ error }) => {
        this.#error = error;
      },
    });
  }

  get status(): ClientStatus {
    if (this.#error !== undefined) return { kind: "failed", error: this.#error };
    return this.#lifecycle.status;
  }

  get snapshot(): WorkspaceLayoutSnapshot | undefined {
    return this.#snapshot;
  }

  get binding(): PoodleLayoutBinding | undefined {
    return this.#binding;
  }

  get projected(): SurfaceDocument | undefined {
    return this.layout.projected;
  }

  async start(): Promise<void> {
    this.#assertAlive();
    ++this.#generation;
    this.#error = undefined;
    await this.layout.start();
    await this.#lifecycle.start();
  }

  async reconnect(): Promise<void> {
    this.#assertAlive();
    ++this.#generation;
    this.#error = undefined;
    this.layout.reconnecting();
    await this.#lifecycle.reconnect();
  }

  async stop(): Promise<void> {
    ++this.#generation;
    this.#pendingCreates.clear();
    this.#binding = undefined;
    this.#snapshot = undefined;
    await this.#lifecycle.stop();
    await this.layout.stop();
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    ++this.#generation;
    this.#pendingCreates.clear();
    this.#binding = undefined;
    this.#snapshot = undefined;
    await this.#lifecycle.destroy();
    await this.layout.destroy();
  }

  nextRequestId(): string {
    this.#requestSequence += 1;
    return `request:nucleus-ui:${this.#clientEpoch}:${this.#requestSequence}`;
  }

  panel(panelInstanceId: PanelInstanceId): WorkspacePanelPresentation | null {
    const projected = this.#snapshot?.panels.find(
      (candidate) => candidate.panel_instance_id === panelInstanceId,
    );
    if (projected) return projected;
    const pending = this.#pendingCreates.get(panelInstanceId);
    return pending ? { panel_instance_id: panelInstanceId, ...pending } : null;
  }

  presentation(panelInstanceId: PanelInstanceId): PanelPresentation | null {
    const panel = this.panel(panelInstanceId);
    return panel ? { label: panel.title, icon: iconForPanel(panel.kind) } : null;
  }

  async createPanel(
    presentation: WorkspacePanelPresentationInput,
  ): Promise<WorkspacePanelPresentation | null> {
    const document = this.layout.projected;
    const snapshot = this.#snapshot;
    if (!document || !snapshot) return null;
    const prepared = await this.#port.prepare(this.projectId, presentation);
    const container = document.surfaces.find(
      (candidate) => candidate.id === snapshot.surface_id,
    );
    const region = container?.regions.find(
      (candidate) => candidate.region_id === prepared.region_id,
    );
    if (!container || !region) {
      throw new Error("prepared panel targets a missing Nucleus layout region");
    }
    const request: LayoutMutationRequest = {
      request_id: this.nextRequestId(),
      expected_revision: document.revision,
      command: {
        kind: "create_panel",
        panel_instance_id: prepared.panel_instance_id,
        panel_definition_id: prepared.panel_definition_id,
        surface_id: snapshot.surface_id,
        region_id: prepared.region_id,
        insertion_index: region.panel_instance_ids.length,
      },
    };
    this.#pendingCreates.set(prepared.panel_instance_id, prepared.presentation);
    try {
      const result = await this.layout.dispatch(
        request,
        projectCreatePanel(request),
      );
      if (result.status === "rejected") {
        this.#error = new Error(result.rejection.detail);
        return null;
      }
      return {
        panel_instance_id: prepared.panel_instance_id,
        ...prepared.presentation,
      };
    } finally {
      this.#pendingCreates.delete(prepared.panel_instance_id);
    }
  }

  async updatePanel(
    panelInstanceId: string,
    presentation: WorkspacePanelPresentationInput,
  ): Promise<void> {
    const generation = this.#generation;
    try {
      const snapshot = await this.#port.update(
        this.projectId,
        panelInstanceId,
        presentation,
      );
      if (generation !== this.#generation || this.#destroyed) return;
      this.#accept(snapshot);
    } catch (error) {
      if (generation === this.#generation && !this.#destroyed) {
        this.#error = error;
      }
      throw error;
    }
  }

  async updateContext(context: WorkspaceProjectContext): Promise<void> {
    const generation = this.#generation;
    try {
      const snapshot = await this.#port.updateContext(this.projectId, context);
      if (generation !== this.#generation || this.#destroyed) return;
      this.#accept(snapshot);
    } catch (error) {
      if (generation === this.#generation && !this.#destroyed) {
        this.#error = error;
      }
      throw error;
    }
  }

  reportResult(result: LayoutDispatchResult): void {
    if (result.status === "rejected") {
      this.#error = new Error(result.rejection.detail);
    }
  }

  reportError(error: unknown): void {
    this.#error = error;
  }

  clearError(): void {
    this.#error = undefined;
  }

  async #dispatch(request: LayoutMutationRequest): Promise<LayoutDispatchResult> {
    const generation = this.#generation;
    const closingPanel =
      request.command.kind === "close_panel"
        ? this.panel(request.command.panel_instance_id)
        : null;
    try {
      const response = await this.#port.mutate(
        this.projectId,
        request,
        request.command.kind === "create_panel"
          ? this.#pendingCreates.get(request.command.panel_instance_id) ?? null
          : null,
      );
      if (generation !== this.#generation || this.#destroyed) {
        throw new StaleWorkspaceLayoutEpochError();
      }
      this.#accept(response.snapshot);
      if (response.result.status === "committed" && closingPanel) {
        this.#options.onPanelClosed?.(closingPanel);
      }
      return response.result;
    } catch (error) {
      if (generation === this.#generation && !this.#destroyed) {
        this.#error = error;
      }
      throw error;
    }
  }

  #accept(snapshot: WorkspaceLayoutSnapshot): void {
    if (
      snapshot.project_id !== this.projectId ||
      this.#destroyed ||
      (this.#snapshot !== undefined &&
        snapshot.projection_revision <= this.#snapshot.projection_revision)
    ) {
      return;
    }
    this.#snapshot = snapshot;
    this.layout.accept(snapshot.document);
    this.#binding ??= createPoodleLayoutBinding({
      state: this.layout,
      definitions: {
        schemas: snapshot.schemas,
        panels: snapshot.panel_definitions,
      },
      nextRequestId: () => this.nextRequestId(),
      onResult: (result) => this.reportResult(result),
      onError: (error) => this.reportError(error),
    });
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("workspace layout session is destroyed");
  }
}

export class StaleWorkspaceLayoutEpochError extends Error {
  constructor() {
    super("workspace layout result belongs to a stale client epoch");
    this.name = "StaleWorkspaceLayoutEpochError";
  }
}

function projectCreatePanel(
  request: LayoutMutationRequest,
): (document: SurfaceDocument) => SurfaceDocument {
  if (request.command.kind !== "create_panel") {
    throw new TypeError("create projector requires a create-panel command");
  }
  const command = request.command;
  return (document) => ({
    ...document,
    surfaces: document.surfaces.map((surface) =>
      surface.id !== command.surface_id
        ? surface
        : {
            ...surface,
            regions: surface.regions.map((region) =>
              region.region_id !== command.region_id
                ? region
                : {
                    ...region,
                    panel_instance_ids: [
                      ...region.panel_instance_ids.slice(0, command.insertion_index),
                      command.panel_instance_id,
                      ...region.panel_instance_ids.slice(command.insertion_index),
                    ],
                    active_panel_instance_id: command.panel_instance_id,
                  },
            ),
          },
    ),
    panel_instances: [
      ...document.panel_instances,
      {
        id: command.panel_instance_id,
        definition_id: command.panel_definition_id,
      },
    ],
  });
}

function createClientEpoch(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function iconForPanel(kind: string): string {
  switch (kind) {
    case "agentChat":
      return "message-square-text";
    case "tasks":
      return "list-checks";
    case "terminal":
      return "terminal";
    case "memory":
      return "panel-right";
    case "forgeDiff":
      return "file-diff";
    default:
      return "panel-top";
  }
}
