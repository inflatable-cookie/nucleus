import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

import NucleusRestoreSettingsPage from "./NucleusRestoreSettingsPage.svelte";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "nucleus_config_restore_status") {
      return {
        outcome: "rejectedOrRolledBack",
        recovery: "rolledBack",
        archiveSha256: "c".repeat(64),
        entries: [],
        detail: "verification failed",
      };
    }
    if (command === "nucleus_config_restore_prepare") {
      return {
        requestId: "nucleus-restore-test",
        archiveSha256: "a".repeat(64),
        domains: [
          "nucleus.command-keymap",
          "nucleus.database",
          "nucleus.notifications",
          "nucleus.panel-presentations",
          "nucleus.preferences",
          "nucleus.project-layouts",
          "nucleus.window-placement",
        ],
        confirmationDigest: "b".repeat(64),
        restartRequired: true,
      };
    }
    if (command === "nucleus_config_restore_confirm") return null;
    throw new Error(`unexpected Tauri command ${command}`);
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

test("reviews one exact seven-domain plan before scheduling restart", async () => {
  render(NucleusRestoreSettingsPage);

  expect(await screen.findByText("Last restore was rolled back")).toBeTruthy();
  expect(screen.getByText("verification failed")).toBeTruthy();
  await fireEvent.click(
    screen.getByRole("button", { name: "Choose backup archive…" }),
  );
  expect(await screen.findByText("nucleus.database")).toBeTruthy();
  expect(screen.getByText("7")).toBeTruthy();
  expect(screen.getByText("Required")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("nucleus_config_restore_prepare");

  await fireEvent.click(
    screen.getByRole("button", { name: "Restore this backup…" }),
  );
  await fireEvent.click(
    screen.getByRole("button", { name: "Restart and restore" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nucleus_config_restore_confirm", {
      confirmation: {
        requestId: "nucleus-restore-test",
        archiveSha256: "a".repeat(64),
        confirmationDigest: "b".repeat(64),
      },
    }),
  );
  expect(
    await screen.findByText(
      "Nucleus is restarting. Keep the application closed until boot recovery completes.",
    ),
  ).toBeTruthy();
});
