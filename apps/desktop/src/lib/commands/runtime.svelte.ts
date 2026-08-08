import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CommandController,
  type CommandAvailabilitySnapshot,
  type CommandCatalogueSnapshot,
  type CommandExecutionIntent,
  type CommandExecutionOutcome,
  type CommandKeymapCommit,
  type CommandKeymapLoadOutcome,
  type CommandKeymapMutationResult,
  type CommandKeymapPreview,
  type CommandKeymapPreviewResult,
  type CommandKeymapReset,
  type CommandPlatform,
  type CommandPorts,
} from "@inflatable-cookie/longhorn/commands";
import { CommandSession } from "@inflatable-cookie/longhorn-poodle-svelte/commands/svelte";

export interface NucleusCommandFacts {
  readonly selectedProjectId: string | null;
  readonly activePanelKind: string | null;
  readonly openPanelKinds: readonly string[];
  readonly activeThread: boolean;
  readonly editorDirty: boolean;
  readonly agentTurnRunning: boolean;
}

export interface NucleusCommandActions {
  readonly openSettings: () => void;
}

const initialFacts: NucleusCommandFacts = {
  selectedProjectId: null,
  activePanelKind: null,
  openPanelKinds: [],
  activeThread: false,
  editorDirty: false,
  agentTurnRunning: false,
};

export class NucleusCommandRuntime {
  readonly session: CommandSession;
  readonly #actions: NucleusCommandActions;
  readonly #availabilityListeners = new Set<() => void>();
  #facts: NucleusCommandFacts = initialFacts;
  #catalogue: CommandCatalogueSnapshot | null = null;
  #availabilityRevision = 0;
  #requestSequence = 0;

  constructor(actions: NucleusCommandActions, keyboardTarget: Window = window) {
    this.#actions = actions;
    const platform = commandPlatform();
    const ports: CommandPorts = {
      catalogue: {
        load: async () => {
          const catalogue = await invoke<CommandCatalogueSnapshot>("longhorn_command_catalogue");
          this.#catalogue = catalogue;
          return catalogue;
        },
        listen: (invalidate) => tauriInvalidation("longhorn://command/catalogue-changed", invalidate),
      },
      keymap: {
        load: () => invoke<CommandKeymapLoadOutcome>("longhorn_command_keymap"),
        preview: (request: CommandKeymapPreview) =>
          invoke<CommandKeymapPreviewResult>("longhorn_command_keymap_preview", { request }),
        commit: (request: CommandKeymapCommit) =>
          invoke<CommandKeymapMutationResult>("longhorn_command_keymap_commit", { request }),
        reset: (request: CommandKeymapReset) =>
          invoke<CommandKeymapMutationResult>("longhorn_command_keymap_reset", { request }),
        listen: (invalidate) => tauriInvalidation("longhorn://command/keymap-changed", invalidate),
      },
      availability: {
        load: () => this.#loadAvailability(),
        listen: (invalidate) => {
          this.#availabilityListeners.add(invalidate);
          return () => {
            this.#availabilityListeners.delete(invalidate);
          };
        },
      },
      executor: { execute: (intent) => this.#execute(intent) },
      nextRequestId: () => `request:nucleus-command:${++this.#requestSequence}`,
    };
    const controller = new CommandController({ ports, platform });
    this.session = new CommandSession({
      controller,
      platform,
      contextPath: () => nucleusCommandContextPath(this.#facts),
      keyboardTarget,
    });
  }

  updateFacts(facts: NucleusCommandFacts): void {
    if (JSON.stringify(this.#facts) === JSON.stringify(facts)) return;
    this.#facts = { ...facts, openPanelKinds: [...facts.openPanelKinds] };
    this.#availabilityRevision += 1;
    for (const listener of this.#availabilityListeners) listener();
  }

  async #loadAvailability(): Promise<CommandAvailabilitySnapshot> {
    const catalogue = this.#catalogue
      ?? await invoke<CommandCatalogueSnapshot>("longhorn_command_catalogue");
    this.#catalogue = catalogue;
    return {
      registryGeneration: catalogue.registryGeneration,
      contextRevision: this.#availabilityRevision,
      records: catalogue.commands.map(({ id }) => ({
        commandId: id,
        availability: projectNucleusCommandAvailability(id, this.#facts),
      })),
    };
  }

  async #execute(intent: CommandExecutionIntent): Promise<CommandExecutionOutcome> {
    const catalogue = this.#catalogue;
    if (!catalogue || intent.registryGeneration !== catalogue.registryGeneration) {
      return { status: "staleRegistry" };
    }
    if (intent.observedContextRevision !== this.#availabilityRevision) {
      return { status: "rejected", evidence: "Command context changed. Try again." };
    }
    if (!catalogue.commands.some(({ id }) => id === intent.invocation.commandId)) {
      return { status: "unknownCommand" };
    }
    const availability = projectNucleusCommandAvailability(intent.invocation.commandId, this.#facts);
    if (availability.state !== "available") {
      return { status: "unavailable", evidence: availability.reason?.detail ?? undefined };
    }
    try {
      executeProductAction(intent.invocation.commandId, this.#actions, this.session);
      return { status: "succeeded" };
    } catch (error) {
      return { status: "failed", evidence: error instanceof Error ? error.message : String(error) };
    }
  }
}

type Availability = CommandAvailabilitySnapshot["records"][number]["availability"];

export function projectNucleusCommandAvailability(
  commandId: string,
  facts: NucleusCommandFacts,
): Availability {
  if (commandId === "nucleus:shell.show-command-palette" || commandId === "nucleus:shell.open-settings") {
    return available();
  }
  if (
    commandId === "nucleus:project.create"
    || commandId === "nucleus:project.manage"
    || commandId === "nucleus:project.refresh"
    || commandId.startsWith("nucleus:sidebar.")
  ) return available();
  if (commandId.startsWith("nucleus:project.")) {
    return facts.selectedProjectId ? available() : unavailable("Select a project first.");
  }
  if (commandId.startsWith("nucleus:thread.")) {
    return facts.activeThread ? available() : unavailable("Open an Agent Chat thread first.");
  }
  if (commandId.startsWith("nucleus:panel.open-")) {
    if (!facts.selectedProjectId) return unavailable("Select a project first.");
    if (commandId === "nucleus:panel.open-tasks" && facts.openPanelKinds.includes("tasks")) {
      return unavailable("The project already has a Tasks panel open.");
    }
    return available();
  }
  if (commandId === "nucleus:panel.close-active") {
    return facts.activePanelKind ? available() : unavailable("No workspace panel is active.");
  }
  if (commandId === "nucleus:editor.quick-open") {
    return facts.activePanelKind === "editor" ? available() : unavailable("Focus an Editor panel first.");
  }
  if (commandId === "nucleus:editor.save") {
    return facts.activePanelKind === "editor" && facts.editorDirty
      ? available()
      : unavailable("The active editor has no unsaved changes.");
  }
  if (commandId === "nucleus:forge.refresh") {
    return facts.selectedProjectId ? available() : unavailable("Select a project first.");
  }
  if (commandId === "nucleus:agent.cancel-turn") {
    return facts.agentTurnRunning ? available() : unavailable("No Agent Chat turn is running.");
  }
  return unavailable("This command is not supported in the current context.");
}

function available(): Availability {
  return { state: "available", reason: null };
}

function unavailable(detail: string): Availability {
  return {
    state: "unavailable",
    reason: { code: { kind: "consumer", code: "nucleus:currently-unavailable" }, detail },
  };
}

function executeProductAction(
  commandId: string,
  actions: NucleusCommandActions,
  session: CommandSession,
): void {
  if (commandId === "nucleus:shell.show-command-palette") {
    session.setOpen(true);
    return;
  }
  if (commandId === "nucleus:shell.open-settings") {
    actions.openSettings();
    return;
  }
  const exactEvents: Record<string, string> = {
    "nucleus:project.create": "nucleus:command-create-project",
    "nucleus:project.manage": "nucleus:command-manage-projects",
    "nucleus:project.refresh": "nucleus:projects-changed",
    "nucleus:sidebar.show-projects": "nucleus:command-show-projects",
    "nucleus:sidebar.show-threads": "nucleus:command-show-threads",
    "nucleus:sidebar.show-files": "nucleus:command-show-files",
    "nucleus:sidebar.show-forge": "nucleus:command-show-forge",
    "nucleus:project.rename-selected": "nucleus:command-rename-project",
    "nucleus:project.manage-resources": "nucleus:command-manage-project-resources",
    "nucleus:project.park-selected": "nucleus:command-park-project",
    "nucleus:project.archive-selected": "nucleus:command-archive-project",
    "nucleus:thread.rename-active": "nucleus:command-rename-thread",
    "nucleus:thread.convert-to-project": "nucleus:command-convert-thread",
    "nucleus:panel.close-active": "nucleus:command-close-active-panel",
    "nucleus:editor.quick-open": "nucleus:command-editor-quick-open",
    "nucleus:editor.save": "nucleus:command-editor-save",
    "nucleus:forge.refresh": "nucleus:command-forge-refresh",
    "nucleus:agent.cancel-turn": "nucleus:command-cancel-agent-turn",
  };
  const panelKinds: Record<string, string> = {
    "nucleus:panel.open-agent-chat": "agentChat",
    "nucleus:panel.open-browser": "browser",
    "nucleus:panel.open-editor": "editor",
    "nucleus:panel.open-terminal": "terminal",
    "nucleus:panel.open-tasks": "tasks",
    "nucleus:panel.open-diff": "diff",
    "nucleus:panel.open-memory": "memory",
  };
  const panelKind = panelKinds[commandId];
  if (panelKind) {
    window.dispatchEvent(new CustomEvent("nucleus:create-workspace-panel", { detail: { kind: panelKind } }));
    return;
  }
  const eventName = exactEvents[commandId];
  if (!eventName) throw new Error(`No product action is registered for ${commandId}`);
  window.dispatchEvent(new CustomEvent(eventName));
}

export function nucleusCommandContextPath(facts: NucleusCommandFacts): readonly string[] {
  const path = ["global", "workspace"];
  if (!facts.selectedProjectId) return path;
  path.push("project");
  if (!facts.activePanelKind) return path;
  path.push("panel");
  if (facts.activePanelKind === "agentChat") path.push("agent-chat");
  if (facts.activePanelKind === "editor") path.push("editor");
  if (facts.activePanelKind === "forge" || facts.activePanelKind === "forgeDiff") path.push("forge");
  return path;
}

function commandPlatform(): CommandPlatform {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("windows")) return "windows";
  if (agent.includes("linux")) return "linux";
  return "macOs";
}

async function tauriInvalidation(event: string, invalidate: () => void): Promise<() => void> {
  const unlisten = await listen(event, invalidate);
  return unlisten;
}
