import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EventTransport, Unlisten } from "@longhorn/core";
import {
  SETTINGS_SCOPE_CHANGED_EVENT,
  SettingsClient,
  type SettingsRegistrySnapshot,
  type SettingsScopeSnapshot,
} from "@longhorn/settings";
import { SettingsSession } from "@longhorn/settings/svelte";

export const GENERAL_PAGE_ID = "nucleus:general";
export const APPEARANCE_PAGE_ID = "nucleus:appearance";
export const AGENT_PAGE_ID = "nucleus:agent-provider";
export const GENERAL_RENDERER_ID = "nucleus:settings-general";
export const APPEARANCE_RENDERER_ID = "nucleus:settings-appearance";
export const AGENT_RENDERER_ID = "nucleus:settings-agent-provider";
export const GENERAL_SCOPE_ID = "nucleus:general-preferences";
export const APPEARANCE_SCOPE_ID = "nucleus:appearance-preferences";
export const AGENT_SCOPE_ID = "nucleus:agent-preferences";
export const GENERAL_UNIT_ID = "nucleus:general-preferences";
export const APPEARANCE_UNIT_ID = "nucleus:appearance-preferences";
export const AGENT_UNIT_ID = "nucleus:agent-preferences";
export const FIXTURE_STATUS_ENTRY_ID = "nucleus:show-fixture-status";
export const DENSITY_ENTRY_ID = "nucleus:interface-density";
export const DEFAULT_MODEL_ENTRY_ID = "nucleus:default-agent-model";
export const DEFAULT_PROVIDER_INSTANCE_ENTRY_ID = "nucleus:default-agent-provider";
export const DEFAULT_PROVIDER_ID_ENTRY_ID = "nucleus:default-model-provider";
export const DEFAULT_REASONING_ENTRY_ID = "nucleus:default-agent-reasoning";
export const DEFAULT_HARNESS_MODE_ENTRY_ID = "nucleus:default-harness-mode";

export interface AgentChatDefaults {
  readonly providerInstanceId: string;
  readonly providerId: string | null;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly harnessMode: "normal" | "plan";
}

export interface DesktopPreferencesProjection {
  readonly showFixtureStatus: boolean;
  readonly density: "compact" | "comfortable";
  readonly agent: AgentChatDefaults;
}

let requestSequence = 0;

export function createTauriSettingsClient(): SettingsClient {
  return new SettingsClient(tauriSettingsTransport());
}

export function createNucleusSettingsSession(
  onClose: () => void,
  onError?: (error: unknown) => void,
): SettingsSession {
  return new SettingsSession({
    client: createTauriSettingsClient(),
    nextRequestId,
    initialRoute: { pageId: GENERAL_PAGE_ID },
    onClose,
    onError,
  });
}

export async function loadDesktopPreferences(
  client = createTauriSettingsClient(),
): Promise<DesktopPreferencesProjection> {
  const registry = await client.registry();
  const [general, appearance, agent] = await Promise.all([
    loadScope(client, registry, GENERAL_SCOPE_ID),
    loadScope(client, registry, APPEARANCE_SCOPE_ID),
    loadScope(client, registry, AGENT_SCOPE_ID),
  ]);
  return {
    showFixtureStatus: booleanValue(general, FIXTURE_STATUS_ENTRY_ID, true),
    density: densityValue(appearance),
    agent: {
      providerInstanceId: stringValue(
        agent,
        DEFAULT_PROVIDER_INSTANCE_ENTRY_ID,
        "codex:local-default",
      ),
      providerId: nullableStringValue(agent, DEFAULT_PROVIDER_ID_ENTRY_ID),
      model: stringValue(agent, DEFAULT_MODEL_ENTRY_ID, "gpt-5.4-mini"),
      reasoningEffort: stringValue(agent, DEFAULT_REASONING_ENTRY_ID, "low"),
      harnessMode: harnessModeValue(agent),
    },
  };
}

function nullableStringValue(snapshot: SettingsScopeSnapshot, entryId: string): string | null {
  const value = snapshot.values.find(({ entryId: id }) => id === entryId)?.effective.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function watchDesktopPreferences(
  listener: (preferences: DesktopPreferencesProjection) => void,
  onError?: (error: unknown) => void,
): Promise<Unlisten> {
  const client = createTauriSettingsClient();
  let active = true;
  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    try {
      const preferences = await loadDesktopPreferences(client);
      if (active && generation === refreshGeneration) listener(preferences);
    } catch (error) {
      if (active) onError?.(error);
    }
  };
  const unlisten = await listen<unknown>(SETTINGS_SCOPE_CHANGED_EVENT, () => {
    void refresh();
  });
  await refresh();
  return () => {
    active = false;
    unlisten();
  };
}

function tauriSettingsTransport(): EventTransport {
  return {
    invoke: (command, arguments_) => invoke(command, arguments_),
    listen: async (event, listener) => {
      const unlisten = await listen<unknown>(event, ({ payload }) => listener(payload));
      return unlisten;
    },
  };
}

async function loadScope(
  client: SettingsClient,
  registry: SettingsRegistrySnapshot,
  scopeId: string,
): Promise<SettingsScopeSnapshot> {
  const outcome = await client.load(registry, {
    protocolVersion: 1,
    requestId: nextRequestId(),
    registryGeneration: registry.generation,
    scopeId,
    knownAuthority: null,
  });
  if (outcome.status !== "loaded") {
    throw new Error(`settings scope ${scopeId} was rejected: ${outcome.rejection.code}`);
  }
  return outcome.snapshot;
}

function booleanValue(
  snapshot: SettingsScopeSnapshot,
  entryId: string,
  fallback: boolean,
): boolean {
  const value = snapshot.values.find(({ entryId: id }) => id === entryId)?.effective.value;
  return typeof value === "boolean" ? value : fallback;
}

function densityValue(
  snapshot: SettingsScopeSnapshot,
): "compact" | "comfortable" {
  const value = snapshot.values.find(({ entryId }) => entryId === DENSITY_ENTRY_ID)
    ?.effective.value;
  return value === "comfortable" ? "comfortable" : "compact";
}

function stringValue(
  snapshot: SettingsScopeSnapshot,
  entryId: string,
  fallback: string,
): string {
  const value = snapshot.values.find(({ entryId: id }) => id === entryId)?.effective.value;
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function harnessModeValue(snapshot: SettingsScopeSnapshot): "normal" | "plan" {
  return stringValue(snapshot, DEFAULT_HARNESS_MODE_ENTRY_ID, "normal") === "plan"
    ? "plan"
    : "normal";
}

function nextRequestId(): string {
  requestSequence += 1;
  return `request:nucleus-settings:${requestSequence}`;
}
