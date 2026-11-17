import React from "react";
import { createRoot } from "react-dom/client";
import { WebApp } from "./app";
import { pairWebSession } from "./transport";

const fragment = new URLSearchParams(window.location.hash.slice(1));
const token = fragment.get("token");
const expiresAt = Number(fragment.get("expiresAt"));
window.history.replaceState(null, "", window.location.pathname);
const root = createRoot(document.getElementById("root")!);
root.render(<p>Connecting to the Nucleus board…</p>);
const validLink = !!token && Number.isFinite(expiresAt) && expiresAt > 0;
void pairWebSession(validLink ? token! : undefined).then(
  () => root.render(<WebApp />),
  error => root.render(<p role="alert">{error instanceof Error ? error.message : String(error)}. Open a fresh board link using nucleus ui.</p>),
);
