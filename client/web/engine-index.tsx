import React from "react";
import { createRoot } from "react-dom/client";
import { errorText } from "../error-text";
import { WebApp } from "./app";
import { requestRustBoard } from "./rust-board";

const fragment = new URLSearchParams(window.location.hash.slice(1));
const token = fragment.get("token");
window.history.replaceState(null, "", window.location.pathname);

const target = document.getElementById("root");
if (!target) throw new Error("Missing Nucleus board root.");
const root = createRoot(target);

async function start() {
  if (token) {
    await requestRustBoard("/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  root.render(<WebApp />);
}

root.render(<p role="status">Connecting to the Nucleus engine…</p>);
void start().catch((error: unknown) =>
  root.render(
    <p role="alert">
      {errorText(error)} Open a fresh board link using nucleus-engine ui.
    </p>,
  ),
);
