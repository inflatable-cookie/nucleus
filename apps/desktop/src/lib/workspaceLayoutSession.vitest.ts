import { render, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import type {
  SurfaceDocument,
  LayoutMutationRequest,
  LayoutSchemaDefinition,
} from "@inflatable-cookie/longhorn/layout";
import type { ConnectionFailureReporter } from "@inflatable-cookie/longhorn/core";
import type { ReactiveConnection } from "@inflatable-cookie/longhorn-poodle-svelte";

import WorkspaceLayoutSessionHarness from "./WorkspaceLayoutSessionHarness.svelte";
import {
  StaleWorkspaceLayoutEpochError,
  type WorkspaceLayoutPort,
  type WorkspaceLayoutSession,
} from "./workspaceLayout.svelte";
import type {
  WorkspaceLayoutMutationResponse,
  WorkspaceLayoutSnapshot,
  WorkspacePanelPresentationInput,
  WorkspacePreparedPanel,
  WorkspaceProjectContext,
} from "./workspaceLayout";

describe("WorkspaceLayoutSession", () => {
  it("isolates mounted project switches, tears down listeners, and remounts cleanly", async () => {
    const port = new ControlledPort();
    const sessions: WorkspaceLayoutSession[] = [];
    const screen = render(WorkspaceLayoutSessionHarness, {
      props: {
        projectId: "project:alpha",
        port,
        onSession: (session) => sessions.push(session),
      },
    });

    await waitFor(() => expect(port.connections).toHaveLength(1));
    expect(port.order).toEqual(["listen:project:alpha"]);

    await screen.rerender({
      projectId: "project:beta",
      port,
      onSession: (session) => sessions.push(session),
    });
    await waitFor(() => expect(port.connections).toHaveLength(2));
    await waitFor(() => expect(port.connections[0].disposed).toBe(true));

    port.connections[0].publish(snapshot("project:alpha", 10, 10));
    port.connections[1].publish(snapshot("project:beta", 1, 1));
    await waitFor(() => expect(screen.getByTestId("project").textContent).toBe("project:beta"));
    expect(sessions[0].snapshot).toBeUndefined();
    expect(sessions[1].snapshot?.project_id).toBe("project:beta");
    expect(port.order).toEqual([
      "listen:project:alpha",
      "listen:project:beta",
      "snapshot:project:alpha",
      "snapshot:project:beta",
    ]);

    screen.unmount();
    await waitFor(() => expect(port.connections[1].disposed).toBe(true));

    const remount = render(WorkspaceLayoutSessionHarness, {
      props: { projectId: "project:gamma", port },
    });
    await waitFor(() => expect(port.connections).toHaveLength(3));
    port.connections[2].publish(snapshot("project:gamma", 1, 1));
    await waitFor(() => expect(remount.getByTestId("project").textContent).toBe("project:gamma"));
    remount.unmount();
  });

  it("drops a late mutation result from the previous mounted project epoch", async () => {
    const port = new ControlledPort();
    const sessions: WorkspaceLayoutSession[] = [];
    const screen = render(WorkspaceLayoutSessionHarness, {
      props: {
        projectId: "project:alpha",
        port,
        onSession: (session) => sessions.push(session),
      },
    });
    await waitFor(() => expect(port.connections).toHaveLength(1));
    port.connections[0].publish(snapshot("project:alpha", 1, 1));
    await waitFor(() => expect(sessions[0].status.kind).toBe("ready"));

    const request: LayoutMutationRequest = {
      request_id: "request:late-alpha",
      expected_revision: 1,
      command: {
        kind: "set_region_collapsed",
        surface_id: "container:workspace",
        region_id: "main",
        collapsed: true,
      },
    };
    const pending = sessions[0].layout.dispatch(request, (document) => document);
    expect(sessions[0].layout.pendingRequestIds).toEqual([request.request_id]);

    await screen.rerender({
      projectId: "project:beta",
      port,
      onSession: (session) => sessions.push(session),
    });
    await waitFor(() => expect(port.connections[0].disposed).toBe(true));
    port.resolveMutation(committed(request, snapshot("project:alpha", 2, 2)));

    await expect(pending).rejects.toBeInstanceOf(StaleWorkspaceLayoutEpochError);
    expect(sessions[0].snapshot).toBeUndefined();
    expect(sessions[0].layout.pendingRequestIds).toEqual([]);
    expect(port.mutations[0]).toMatchObject({
      projectId: "project:alpha",
      request,
      createPanel: null,
    });
    screen.unmount();
  });

  it("projects typed project context through the mounted workspace session", async () => {
    const port = new ControlledPort();
    const sessions: WorkspaceLayoutSession[] = [];
    const screen = render(WorkspaceLayoutSessionHarness, {
      props: {
        projectId: "project:alpha",
        port,
        onSession: (session) => sessions.push(session),
      },
    });
    await waitFor(() => expect(port.connections).toHaveLength(1));
    port.connections[0].publish(snapshot("project:alpha", 1, 1));
    await waitFor(() => expect(sessions[0].status.kind).toBe("ready"));

    const context: WorkspaceProjectContext = {
      selected_goal_id: "goal:alpha",
      selected_task_id: "task:alpha",
      active_conversation_id: "conversation:alpha",
    };
    await sessions[0].updateContext(context);

    expect(port.contextUpdates).toEqual([{ projectId: "project:alpha", context }]);
    expect(sessions[0].snapshot?.context).toEqual(context);
    screen.unmount();
  });
});

class ControlledPort implements WorkspaceLayoutPort {
  readonly connections: ControlledConnection[] = [];
  readonly mutations: Array<{
    projectId: string;
    request: LayoutMutationRequest;
    createPanel: WorkspacePanelPresentationInput | null;
  }> = [];
  readonly order: string[] = [];
  readonly contextUpdates: Array<{
    projectId: string;
    context: WorkspaceProjectContext;
  }> = [];
  #mutation = deferred<WorkspaceLayoutMutationResponse>();

  connect(
    projectId: string,
    listener: (snapshot: WorkspaceLayoutSnapshot) => void,
    _onFailure: ConnectionFailureReporter,
  ): ReactiveConnection<WorkspaceLayoutSnapshot> {
    this.order.push(`listen:${projectId}`);
    const connection = new ControlledConnection(projectId, listener, this.order);
    this.connections.push(connection);
    return connection;
  }

  prepare(
    _projectId: string,
    _presentation: WorkspacePanelPresentationInput,
  ): Promise<WorkspacePreparedPanel> {
    throw new Error("prepare is outside this lifecycle proof");
  }

  mutate(
    projectId: string,
    request: LayoutMutationRequest,
    createPanel: WorkspacePanelPresentationInput | null,
  ): Promise<WorkspaceLayoutMutationResponse> {
    this.mutations.push({ projectId, request, createPanel });
    return this.#mutation.promise;
  }

  update(): Promise<WorkspaceLayoutSnapshot> {
    throw new Error("update is outside this lifecycle proof");
  }

  updateContext(
    projectId: string,
    context: WorkspaceProjectContext,
  ): Promise<WorkspaceLayoutSnapshot> {
    this.contextUpdates.push({ projectId, context });
    return Promise.resolve({
      ...snapshot(projectId, 2, 1),
      context,
    });
  }

  resolveMutation(response: WorkspaceLayoutMutationResponse): void {
    this.#mutation.resolve(response);
  }
}

class ControlledConnection implements ReactiveConnection<WorkspaceLayoutSnapshot> {
  readonly ready: Promise<void>;
  disposed = false;
  #current: WorkspaceLayoutSnapshot | undefined;
  readonly #ready = deferred<void>();
  readonly #listener: (snapshot: WorkspaceLayoutSnapshot) => void;
  readonly #order: string[];

  constructor(
    readonly projectId: string,
    listener: (snapshot: WorkspaceLayoutSnapshot) => void,
    order: string[],
  ) {
    this.#listener = listener;
    this.#order = order;
    this.ready = this.#ready.promise;
  }

  current(): WorkspaceLayoutSnapshot | undefined {
    return this.#current;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  publish(value: WorkspaceLayoutSnapshot): void {
    this.#order.push(`snapshot:${value.project_id}`);
    this.#current = value;
    this.#listener(value);
    this.#ready.resolve(undefined);
  }
}

function snapshot(
  projectId: string,
  projectionRevision: number,
  layoutRevision: number,
): WorkspaceLayoutSnapshot {
  const schema: LayoutSchemaDefinition = {
    id: "schema:test",
    regions: [
      {
        id: "main",
        family_id: "family:main",
        order: 0,
        empty_policy: "keep_visible",
        collapsible: true,
      },
    ],
    sizing_slots: [],
  };
  const document: SurfaceDocument = {
    revision: layoutRevision,
    surfaces: [
      {
        id: "surface:workspace",
        schema_id: schema.id,
        label: null,
        presentation: { kind: "regional" },
        host_preferences: [],
        regions: [
          {
            region_id: "main",
            panel_instance_ids: [],
            active_panel_instance_id: null,
            collapsed: false,
          },
        ],
        sizing_slots: [],
      },
    ],
    panel_instances: [],
    windows: [],
  };
  return {
    projection_revision: projectionRevision,
    project_id: projectId,
    surface_id: "container:workspace",
    document,
    schemas: [schema],
    panel_definitions: [],
    panels: [],
    context: {
      selected_goal_id: null,
      selected_task_id: null,
      active_conversation_id: null,
    },
  };
}

function committed(
  request: LayoutMutationRequest,
  authoritative: WorkspaceLayoutSnapshot,
): WorkspaceLayoutMutationResponse {
  if (request.command.kind !== "set_region_collapsed") {
    throw new TypeError("test expects a collapse request");
  }
  return {
    result: {
      status: "committed",
      receipt: {
        request_id: request.request_id,
        previous_revision: request.expected_revision,
        committed_revision: authoritative.document.revision,
        outcome: {
          kind: "region_collapsed_set",
          surface_id: request.command.surface_id,
          region_id: request.command.region_id,
          previous_collapsed: false,
          committed_collapsed: request.command.collapsed,
        },
        authoritative_document: authoritative.document,
      },
    },
    snapshot: authoritative,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve_) => {
    resolve = resolve_;
  });
  return { promise, resolve };
}
