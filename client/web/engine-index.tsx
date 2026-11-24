import React from "react";
import { createRoot } from "react-dom/client";
import { errorText } from "../error-text";
import { EngineApp } from "./engine-app";
import { readBrowserSession } from "./engine-settings-api";
import { requestRustBoard } from "./rust-board";
import { engineBoardTheme } from "./theme";

const fragment = new URLSearchParams(window.location.hash.slice(1));
const token = fragment.get("token");
window.history.replaceState(null, "", window.location.pathname);

const target = document.getElementById("root");
if (!target) throw new Error("Missing Nucleus board root.");
const root = createRoot(target);
const colors = engineBoardTheme.colors;
document.documentElement.style.colorScheme = "dark";
document.body.style.background = colors.surface0;
document.body.style.color = colors.foreground;

async function start() {
  if (token) {
    const response = await requestRustBoard("/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("The board link could not be paired.");
  }
  const session = await readBrowserSession();
  root.render(<EngineApp canEditSettings={session.canEditSettings} />);
}

root.render(<p role="status">Connecting to the Nucleus engine…</p>);
void start().catch((error: unknown) =>
  root.render(
    <p role="alert">
      {errorText(error)} Open a fresh board link using nucleus-engine ui.
    </p>,
  ),
);
