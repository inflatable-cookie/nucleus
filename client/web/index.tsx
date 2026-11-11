import React from "react";
import { createRoot } from "react-dom/client";
import { WebApp } from "./app";

const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
window.history.replaceState(null, "", window.location.pathname);
const root = createRoot(document.getElementById("root")!);
root.render(token ? <WebApp token={token} /> : <p>Open a fresh board link using nucleus ui.</p>);
