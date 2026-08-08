import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

import { SETTINGS_APPLY_COMMAND } from "@inflatable-cookie/longhorn/settings";

import SettingsDialog from "./SettingsDialog.svelte";
import { DEFAULT_HARNESS_MODE_ENTRY_ID } from "./client";
import { enabledButton, SettingsTransport, settingsSession } from "./settingsDialog.fixture";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, arguments_?: Record<string, unknown>) => {
    if (command === "agent_chat_credential_action") {
      const request = arguments_?.request as {
        request_id: string;
        provider_instance_id: string;
        action: "setup" | "repair" | "revoke";
      };
      return {
        request_id: request.request_id,
        provider_instance_id: request.provider_instance_id,
        credential_ref: null,
        action: request.action,
        outcome: "unavailable",
        code: "provider_managed_lifecycle",
        changed: false,
      };
    }
    if (command !== "agent_chat_provider_catalogue") {
      throw new Error(`unexpected Tauri command ${command}`);
    }
    return { instances: [{
      provider_instance_id: "codex:local-default",
      instance_revision: "1",
      runtime_adapter_id: "codex-app-server",
      driver_id: "swallowtail.codex.app-server",
      integration_family: "codex",
      transport_family: "stdio-json-rpc",
      protocol_facade_id: "codex-app-server-v2",
      display_name: "Local Codex",
      harness_name: "Codex app-server",
      ownership: "host_owned_persistent",
      selection_readiness: "ready",
      credential_posture: {
        profile_id: "nucleus.codex.oauth",
        mechanism: "interactive_oauth",
        credential_state: "ready",
        entitlement_metering: "subscription_allowance",
        entitlement_state: "available",
        endpoint_authorization: "allowed",
        runtime_readiness: "ready",
        support_authority: "provider_supported",
        evidence_provenance: "observed",
      },
      credential: {
        access_profile_ref: "nucleus.codex.oauth",
        credential_ref: null,
        mechanism: "interactive_oauth",
        entitlement_metering: "subscription_allowance",
        ownership: "provider_managed",
        status: "ready",
        evidence_posture: "caller_asserted",
        actions: ["setup", "repair", "revoke"].map((action) => ({
          action,
          availability: "unavailable",
          unavailable_reason: "provider_managed_lifecycle",
        })),
      },
      model_catalogue_state: "available",
      model_catalogue_diagnostic: null,
      models: [{
        provider_id: null,
        model: "gpt-5.4-mini",
        display_name: "GPT-5.4 Mini",
        description: "",
        default_reasoning_effort: "low",
        supported_reasoning_efforts: [
          { reasoning_effort: "high", description: "" },
          { reasoning_effort: "low", description: "" },
        ],
      }],
    }] };
  }),
}));

afterEach(() => cleanup());

test("Settings dialog guards staged work, applies both modes, tears down, and remounts", async () => {
  const transport = new SettingsTransport();
  const closed = vi.fn();
  const session = settingsSession(transport, closed);
  const screen = render(SettingsDialog, {
    props: { session, onOpenChange: closed },
  });

  await screen.findByTestId("settings-general-page");
  expect(screen.queryByText("Providers")).toBeNull();
  for (const absentPage of ["Workspace", "Browser", "Terminal", "Forge", "Advanced"]) {
    expect(screen.queryByRole("button", { name: absentPage })).toBeNull();
  }
  expect(screen.getByLabelText("General").getAttribute("tabindex")).toBe("-1");

  await fireEvent.click(screen.getByRole("switch", { name: "Show fixture status" }));
  await waitFor(() => expect(transport.generalValue()).toBe(false));
  expect(transport.calls(SETTINGS_APPLY_COMMAND)).toBe(1);

  await fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  await screen.findByTestId("settings-appearance-page");
  expect(screen.queryByTestId("settings-general-page")).toBeNull();
  await fireEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);

  await fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await screen.findByText("Unsaved changes");
  await fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect(closed).not.toHaveBeenCalled();

  await fireEvent.click(enabledButton(screen.getAllByRole("button", { name: "Apply" })));
  await waitFor(() => expect(transport.appearanceValue()).toBe("comfortable"));
  await fireEvent.click(screen.getByRole("button", { name: "General" }));
  await screen.findByTestId("settings-general-page");
  await fireEvent.click(screen.getByRole("switch", { name: "Show fixture status" }));
  await waitFor(() => expect(transport.generalValue()).toBe(true));
  expect(screen.queryByText("Settings changed elsewhere")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(closed).toHaveBeenCalled());
  screen.unmount();
  await waitFor(() => expect(transport.activeListenerCount()).toBe(0));

  const remountSession = settingsSession(transport, vi.fn());
  const remount = render(SettingsDialog, {
    props: { session: remountSession, onOpenChange: vi.fn() },
  });
  await remount.findByTestId("settings-general-page");
  await fireEvent.click(remount.getByRole("button", { name: "Appearance" }));
  await remount.findByTestId("settings-appearance-page");
  expect((remount.getByRole("radio", { name: "Comfortable" }) as HTMLInputElement).checked).toBe(true);
  remount.unmount();
  await waitFor(() => expect(transport.activeListenerCount()).toBe(0));
});

test("stale apply presents a conflict and preserves the staged draft", async () => {
  const transport = new SettingsTransport();
  transport.conflictNext = true;
  const screen = render(SettingsDialog, {
    props: { session: settingsSession(transport, vi.fn()), onOpenChange: vi.fn() },
  });
  await screen.findByTestId("settings-general-page");
  await fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  await screen.findByTestId("settings-appearance-page");
  await fireEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
  await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Settings changed elsewhere");
  expect((screen.getByRole("radio", { name: "Comfortable" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false);
  screen.unmount();
});

test("Agent settings show provider readiness and stage explicit session defaults", async () => {
  const transport = new SettingsTransport();
  const screen = render(SettingsDialog, {
    props: { session: settingsSession(transport, vi.fn()), onOpenChange: vi.fn() },
  });
  await screen.findByTestId("settings-general-page");
  await fireEvent.click(screen.getByRole("button", { name: "Agent & models" }));
  await screen.findByTestId("settings-agent-provider-page");
  await screen.findByText("1 models available through provider-managed login");
  expect(screen.getByText("Codex app-server")).toBeTruthy();
  expect(screen.queryByLabelText("Default agent provider")).toBeNull();
  expect(screen.getByText("Technical details")).toBeTruthy();
  expect(screen.getByText("ChatGPT subscription · Interactive OAuth")).toBeTruthy();
  expect(screen.getByText(/Nucleus stores no credential value or reference/)).toBeTruthy();
  expect(screen.getByLabelText("Default agent model")).toBeTruthy();
  expect(screen.getByLabelText("Default reasoning effort")).toBeTruthy();

  await fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
  await fireEvent.click(enabledButton(screen.getAllByRole("button", { name: "Apply" })));
  await waitFor(() => expect(transport.agentValue(DEFAULT_HARNESS_MODE_ENTRY_ID)).toBe("plan"));

  await fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await screen.findByText("Codex owns revoke for this login; no Nucleus setting changed.");
  expect(transport.agentValue(DEFAULT_HARNESS_MODE_ENTRY_ID)).toBe("plan");
  screen.unmount();
});
