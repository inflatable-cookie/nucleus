import React from "react";
import { createRoot } from "react-dom/client";
import { WebApp } from "./app";

const fragment = new URLSearchParams(window.location.hash.slice(1));
const token = fragment.get("token");
const expiresAt = Number(fragment.get("expiresAt"));
window.history.replaceState(null, "", window.location.pathname);
const root = createRoot(document.getElementById("root")!);
root.render(token && Number.isFinite(expiresAt) && expiresAt > 0 ? <WebApp token={token} expiresAt={expiresAt} /> : <p>Open a fresh board link using nucleus ui.</p>);
