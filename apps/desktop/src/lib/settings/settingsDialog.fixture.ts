import type { EventTransport, Unlisten } from "@inflatable-cookie/longhorn/core";
import {
  SETTINGS_APPLY_COMMAND,
  SETTINGS_LOAD_COMMAND,
  SETTINGS_REGISTRY_COMMAND,
  SETTINGS_RESET_COMMAND,
  SETTINGS_SCOPE_CHANGED_EVENT,
  SettingsClient,
  type SettingsApplyCommand,
  type SettingsMutationResult,
  type SettingsRegistrySnapshot,
  type SettingsResetCommand,
  type SettingsScopeSnapshot,
} from "@inflatable-cookie/longhorn/settings";
import { SettingsSession } from "@inflatable-cookie/longhorn-poodle-svelte/settings/svelte";

import {
  AGENT_PAGE_ID,
  AGENT_RENDERER_ID,
  AGENT_SCOPE_ID,
  AGENT_UNIT_ID,
  APPEARANCE_PAGE_ID,
  APPEARANCE_RENDERER_ID,
  APPEARANCE_SCOPE_ID,
  APPEARANCE_UNIT_ID,
  DENSITY_ENTRY_ID,
  DEFAULT_HARNESS_MODE_ENTRY_ID,
  DEFAULT_MODEL_ENTRY_ID,
  DEFAULT_PROVIDER_INSTANCE_ENTRY_ID,
  DEFAULT_PROVIDER_ID_ENTRY_ID,
  DEFAULT_REASONING_ENTRY_ID,
  FIXTURE_STATUS_ENTRY_ID,
  GENERAL_PAGE_ID,
  GENERAL_RENDERER_ID,
  GENERAL_SCOPE_ID,
  GENERAL_UNIT_ID,
} from "./client";

export function settingsSession(transport: SettingsTransport, onClose: () => void): SettingsSession {
  let sequence = 0;
  return new SettingsSession({
    client: new SettingsClient(transport),
    nextRequestId: () => `request:test-settings:${++sequence}`,
    initialRoute: { pageId: GENERAL_PAGE_ID },
    onClose,
  });
}

export function enabledButton(buttons: HTMLElement[]): HTMLButtonElement {
  const button = buttons.find((candidate) => !(candidate as HTMLButtonElement).disabled);
  if (!button) throw new Error("expected an enabled button");
  return button as HTMLButtonElement;
}

export class SettingsTransport implements EventTransport {
  readonly registry = registrySnapshot();
  readonly scopes = new Map<string, SettingsScopeSnapshot>([
    [GENERAL_SCOPE_ID, scopeSnapshot(GENERAL_SCOPE_ID, FIXTURE_STATUS_ENTRY_ID, true)],
    [APPEARANCE_SCOPE_ID, scopeSnapshot(APPEARANCE_SCOPE_ID, DENSITY_ENTRY_ID, "compact")],
    [AGENT_SCOPE_ID, agentScopeSnapshot()],
  ]);
  readonly trace: string[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  conflictNext = false;

  async invoke(command: string, arguments_: Record<string, unknown>): Promise<unknown> {
    this.trace.push(command);
    if (command === SETTINGS_REGISTRY_COMMAND) return structuredClone(this.registry);
    if (command === SETTINGS_LOAD_COMMAND) {
      const input = arguments_.command as { scopeId: string };
      return { status: "loaded", snapshot: structuredClone(this.requiredScope(input.scopeId)) };
    }
    if (command === SETTINGS_APPLY_COMMAND) {
      return this.apply(arguments_.command as SettingsApplyCommand);
    }
    if (command === SETTINGS_RESET_COMMAND) {
      return this.reset(arguments_.command as SettingsResetCommand);
    }
    throw new Error(`unexpected settings command ${command}`);
  }

  async listen(event: string, listener: (payload: unknown) => void): Promise<Unlisten> {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  calls(command: string): number {
    return this.trace.filter((value) => value === command).length;
  }

  activeListenerCount(): number {
    return [...this.listeners.values()].reduce((total, values) => total + values.size, 0);
  }

  generalValue(): boolean {
    return this.requiredScope(GENERAL_SCOPE_ID).values[0]!.effective.value as boolean;
  }

  appearanceValue(): string {
    return this.requiredScope(APPEARANCE_SCOPE_ID).values[0]!.effective.value as string;
  }

  agentValue(entryId: string): unknown {
    return this.requiredScope(AGENT_SCOPE_ID).values
      .find(({ entryId: candidate }) => candidate === entryId)?.effective.value;
  }

  private apply(command: SettingsApplyCommand): SettingsMutationResult {
    const current = this.requiredScope(command.scopeId);
    if (
      this.conflictNext
      || command.authority.authorityToken !== current.authority.authorityToken
    ) {
      this.conflictNext = false;
      return {
        status: "conflict",
        conflict: { expected: command.authority, actual: current.authority },
        snapshot: structuredClone(current),
      };
    }
    const value = command.intent.value as Record<string, unknown>;
    if (command.applyUnitId === AGENT_UNIT_ID) {
      for (const [entryId, key] of [
        [DEFAULT_PROVIDER_INSTANCE_ENTRY_ID, "defaultProviderInstanceId"],
        [DEFAULT_PROVIDER_ID_ENTRY_ID, "defaultProviderId"],
        [DEFAULT_MODEL_ENTRY_ID, "defaultModel"],
        [DEFAULT_REASONING_ENTRY_ID, "defaultReasoningEffort"],
        [DEFAULT_HARNESS_MODE_ENTRY_ID, "defaultHarnessMode"],
      ] as const) {
        const entry = current.values.find(({ entryId: candidate }) => candidate === entryId)!;
        entry.configured = { codecVersion: 1, value: value[key] };
        entry.effective = { codecVersion: 1, value: value[key] };
        entry.effectiveSource = "userConfiguration";
      }
      const previous = structuredClone(current.authority);
      this.advanceSharedAuthority();
      return applied(command, previous, current);
    }
    const committed = command.applyUnitId === GENERAL_UNIT_ID
      ? value.showFixtureStatus
      : value.density;
    const previous = structuredClone(current.authority);
    current.values[0]!.configured = { codecVersion: 1, value: committed };
    current.values[0]!.effective = { codecVersion: 1, value: committed };
    current.values[0]!.effectiveSource = "userConfiguration";
    this.advanceSharedAuthority();
    return applied(command, previous, current);
  }

  private reset(command: SettingsResetCommand): SettingsMutationResult {
    const current = this.requiredScope(command.scopeId);
    const previous = structuredClone(current.authority);
    for (const entry of current.values.filter(({ entryId }) => command.entryIds.includes(entryId))) {
      entry.configured = null;
      entry.effective = structuredClone(entry.compiledDefault);
      entry.effectiveSource = "compiledDefault";
    }
    this.advanceSharedAuthority();
    return applied(command, previous, current);
  }

  private advanceSharedAuthority(): void {
    const scopeRevision = Math.max(
      ...[...this.scopes.values()].map(({ authority }) => authority.scopeRevision),
    ) + 1;
    for (const scope of this.scopes.values()) {
      scope.authority = {
        registryGeneration: scope.authority.registryGeneration,
        scopeRevision,
        authorityToken: `authority:${scope.scopeId}:${scopeRevision}`,
      };
      for (const listener of this.listeners.get(SETTINGS_SCOPE_CHANGED_EVENT) ?? []) {
        listener({
          protocolVersion: 1,
          registryGeneration: scope.authority.registryGeneration,
          scopeId: scope.scopeId,
          scopeRevision,
        });
      }
    }
  }

  private requiredScope(scopeId: string): SettingsScopeSnapshot {
    const scope = this.scopes.get(scopeId);
    if (!scope) throw new Error(`unknown scope ${scopeId}`);
    return scope;
  }
}

function registrySnapshot(): SettingsRegistrySnapshot {
  const features = {
    reset: true,
    import: false,
    backup: false,
    restore: false,
    confirmation: false,
  };
  return {
    protocolVersion: 1,
    generation: 1,
    digest: "1111111111111111111111111111111111111111111111111111111111111111",
    limits: {
      maximumModules: 128,
      maximumSections: 512,
      maximumPages: 2048,
      maximumRenderers: 512,
      maximumScopes: 2048,
      maximumApplyUnits: 2048,
      maximumCapabilities: 512,
      maximumAnchorsPerPage: 128,
      maximumKeywordsPerPage: 128,
      maximumLabelBytes: 1024,
      maximumKeywordBytes: 256,
      maximumOpaqueValueBytes: 65536,
    },
    composedCapabilities: ["nucleus:desktop-settings"],
    modules: [{ id: "nucleus:desktop-settings", label: "Nucleus", order: 0 }],
    sections: [{
      id: "nucleus:application",
      moduleId: "nucleus:desktop-settings",
      label: "Application",
      order: 0,
    }],
    pages: [
      page(GENERAL_PAGE_ID, GENERAL_RENDERER_ID, "General", 0, GENERAL_SCOPE_ID, GENERAL_UNIT_ID),
      page(AGENT_PAGE_ID, AGENT_RENDERER_ID, "Agent & models", 20, AGENT_SCOPE_ID, AGENT_UNIT_ID),
      page(APPEARANCE_PAGE_ID, APPEARANCE_RENDERER_ID, "Appearance", 10, APPEARANCE_SCOPE_ID, APPEARANCE_UNIT_ID),
    ],
    renderers: [GENERAL_RENDERER_ID, APPEARANCE_RENDERER_ID, AGENT_RENDERER_ID]
      .map((id) => ({ id, moduleId: "nucleus:desktop-settings" })),
    scopes: [GENERAL_SCOPE_ID, APPEARANCE_SCOPE_ID, AGENT_SCOPE_ID]
      .map((id) => ({ id, moduleId: "nucleus:desktop-settings" })),
    applyUnits: [
      applyUnit(GENERAL_UNIT_ID, GENERAL_SCOPE_ID, "immediate"),
      applyUnit(AGENT_UNIT_ID, AGENT_SCOPE_ID, "staged"),
      applyUnit(APPEARANCE_UNIT_ID, APPEARANCE_SCOPE_ID, "staged"),
    ],
    capabilities: [{ id: "nucleus:desktop-settings", moduleId: "nucleus:desktop-settings" }],
  };
}

function page(id: string, rendererId: string, label: string, order: number, scopeId: string, unitId: string) {
  return {
    id,
    moduleId: "nucleus:desktop-settings",
    sectionId: "nucleus:application",
    rendererId,
    label,
    keywords: [],
    order,
    anchors: [],
    requiredCapabilities: ["nucleus:desktop-settings"],
    readableScopeIds: [scopeId],
    writableApplyUnitIds: [unitId],
    features: { reset: true, import: false, backup: false, restore: false, confirmation: false },
  };
}

function applyUnit(id: string, scopeId: string, timing: "immediate" | "staged") {
  return {
    id,
    moduleId: "nucleus:desktop-settings",
    scopeId,
    timing,
    resetSupported: true,
  };
}

function agentScopeSnapshot(): SettingsScopeSnapshot {
  const snapshot = scopeSnapshot(AGENT_SCOPE_ID, DEFAULT_MODEL_ENTRY_ID, "gpt-5.4-mini");
  snapshot.values.push(
    valueProjection(DEFAULT_PROVIDER_INSTANCE_ENTRY_ID, "codex:local-default"),
    valueProjection(DEFAULT_PROVIDER_ID_ENTRY_ID, null),
    valueProjection(DEFAULT_REASONING_ENTRY_ID, "low"),
    valueProjection(DEFAULT_HARNESS_MODE_ENTRY_ID, "normal"),
  );
  return snapshot;
}

function valueProjection(entryId: string, value: unknown): SettingsScopeSnapshot["values"][number] {
  return {
    entryId,
    configured: null,
    effective: { codecVersion: 1, value },
    compiledDefault: { codecVersion: 1, value },
    effectiveSource: "compiledDefault",
    policy: null,
    editability: "editable",
    sourceDiagnostics: [],
  };
}

function scopeSnapshot(scopeId: string, entryId: string, value: unknown): SettingsScopeSnapshot {
  return {
    protocolVersion: 1,
    scopeId,
    authority: {
      registryGeneration: 1,
      scopeRevision: 1,
      authorityToken: `authority:${scopeId}:1`,
    },
    values: [valueProjection(entryId, value)],
    recovery: null,
    activationRequirements: [],
  };
}

function applied(
  command: SettingsApplyCommand | SettingsResetCommand,
  previousAuthority: SettingsScopeSnapshot["authority"],
  snapshot: SettingsScopeSnapshot,
): SettingsMutationResult {
  return {
    status: "applied",
    snapshot: structuredClone(snapshot),
    receipt: {
      requestId: command.requestId,
      pageId: command.pageId,
      applyUnitId: command.applyUnitId,
      scopeId: command.scopeId,
      previousAuthority,
      committedAuthority: structuredClone(snapshot.authority),
      outcome: "changed",
      durability: { kind: "confirmed", evidence: null },
      activationRequirements: [],
    },
  };
}
