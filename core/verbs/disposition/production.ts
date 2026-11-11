import type { DispositionRef, Task } from "../../../shared/contracts";
import type { Store } from "../../store/store";
import { settleCancelledPr } from "../../forge/index";
import type { DispositionDeps } from "./types";
import { listOriginRefs } from "./refs";
import { ownedThreads } from "./state";
import { proveWorkspaceEmpty, proveRetainedByReplacement } from "./workspace";

const AGENT_NOT_FOUND = "Agent was not found";

/** Production remote effects: adapter observations, archives and git-backed work proofs. */
export function productionDeps(options: {
  store: Store;
  hostAvailable?(task: Task): boolean;
  withHost?<T>(id: string, fn: () => T): T;
  hooks: DispositionDeps["hooks"];
  observe(id: string): Promise<{ active: boolean; permissions: boolean; status: string }>;
  archiveAgent(id: string): Promise<void>;
  archiveWorkspace(task: Task, attachedAgentIds: ReadonlySet<string>): Promise<boolean>;
  observeWorkspaceArchived(task: Task): Promise<boolean>;
  archiveSiblings?(task: Task): Promise<void>;
  interruptTurn?(agentId: string, messageId: string, text: string): Promise<void>;
  listRemoteRefs?(task: Task): Promise<DispositionRef[]>;
}): DispositionDeps {
  const { store } = options;
  return {
    hooks: options.hooks,
    hostAvailable: options.hostAvailable,
    withHost: options.withHost,
    ...(options.archiveSiblings ? { archiveSiblings: options.archiveSiblings } : {}),
    ...(options.interruptTurn ? { interruptTurn: options.interruptTurn } : {}),
    listRemoteRefs: options.listRemoteRefs ?? listOriginRefs,
    observeAgent: async (id) => {
      try {
        const state = await options.observe(id);
        return { stopped: !state.active && !state.permissions && ["idle", "error", "closed"].includes(state.status) };
      } catch (error) {
        if (error instanceof Error && error.message === AGENT_NOT_FOUND) return { stopped: true };
        throw error;
      }
    },
    archiveAgent: (id) => options.archiveAgent(id),
    proveWorkspaceEmpty: (task) => proveWorkspaceEmpty(store, task),
    proveRetainedByReplacement: (task, replacement) => proveRetainedByReplacement(task, replacement),
    archiveWorkspace: async (task) => {
      const attached = new Set([...ownedThreads(task, store.runs(task.id)).map((thread) => thread.agentId)]);
      return options.archiveWorkspace(task, attached);
    },
    observeWorkspaceArchived: options.observeWorkspaceArchived,
    settleCancelledPr,
  };
}
