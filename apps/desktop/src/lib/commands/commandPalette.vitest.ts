import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

import CommandPalette from "./CommandPalette.svelte";

afterEach(() => cleanup());

test("palette exposes shared shortcuts, disables unavailable commands, and routes selection", async () => {
  const select = vi.fn();
  const setOpen = vi.fn();
  const setQuery = vi.fn();
  const session = {
    open: true,
    query: "",
    status: { kind: "ready" },
    paletteRecords: [
      {
        id: "nucleus:shell.open-settings",
        label: "Open Settings",
        description: "Open application Settings.",
        categoryPath: ["shell"],
        keywords: ["preferences"],
        icon: null,
        availability: { state: "available", reason: null },
        shortcuts: [{ label: "⌘,", bindingId: "settings" }],
      },
      {
        id: "nucleus:editor.save",
        label: "Save File",
        description: "Save the active dirty editor buffer.",
        categoryPath: ["editor"],
        keywords: ["write"],
        icon: null,
        availability: {
          state: "unavailable",
          reason: {
            code: { kind: "consumer", code: "nucleus:currently-unavailable" },
            detail: "The active editor has no unsaved changes.",
          },
        },
        shortcuts: [{ label: "⌘S", bindingId: "save" }],
      },
    ],
    setOpen,
    setQuery,
    select,
  };
  const trigger = document.createElement("button");
  trigger.textContent = "Return target";
  document.body.append(trigger);
  trigger.focus();

  const screen = render(CommandPalette, { props: { session: session as never } });
  await screen.findByRole("dialog", { name: "Command Palette" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("searchbox")));
  expect(screen.getByText("⌘,")).toBeTruthy();
  expect(screen.getByText("The active editor has no unsaved changes.")).toBeTruthy();
  const unavailable = screen.getByText("Save File").closest("[data-disabled]");
  expect(unavailable?.getAttribute("data-disabled")).toBe("true");

  await fireEvent.click(screen.getByText("Open Settings"));
  expect(select).toHaveBeenCalledWith("nucleus:shell.open-settings");
  await fireEvent.input(screen.getByRole("searchbox"), { target: { value: "settings" } });
  expect(setQuery).toHaveBeenCalledWith("settings");
  await fireEvent.keyDown(window, { key: "Escape" });
  expect(setOpen).toHaveBeenCalledWith(false);
  trigger.remove();
});
