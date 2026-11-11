import { BoardLiveContext } from "../board-live";
import React, { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MainSurface, registerSettingsOpener } from "../queue";
import { QueueSettingsScreen } from "../settings-screen";
import { hintSettingsSection } from "../settings-hint";
import { WebContext } from "./shell";
import { WebQuestions } from "./questions";
import { createWebTransport } from "./transport";
import type { BoardTheme } from "../shell/types";

const theme: BoardTheme = { colors: { surface0: "#111318", surface1: "#1a1d24", surface2: "#252932", border: "#39404b", foreground: "#f1f3f5", foregroundMuted: "#a5acb8", accent: "#8caaff", accentForeground: "#101521", statusSuccess: "#71c99a", statusWarning: "#e9bc68", statusDanger: "#ef8282" } };
const key = ["nucleus", "state"];

export function WebApp({ token }: { token: string }) {
  const [live, setLive] = useState(false);
  const [settings, setSettings] = useState(false);
  const transport = useMemo(() => createWebTransport(token), [token]);
  const query = useMemo(() => new QueryClient(), []);
  const context = useMemo(() => ({ transport, settings }), [transport, settings]);
  useEffect(() => { registerSettingsOpener(section => { if (section) hintSettingsSection(section); setSettings(true); }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function listen() {
      while (!controller.signal.aborted) {
        try {
          const response = await transport.events(controller.signal);
          if (!response.ok || !response.body) throw new Error(`Live channel: ${response.status}`);
          setLive(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end); pending = pending.slice(end + 2);
              const event = /^event: (.+)$/m.exec(frame)?.[1];
              const data = /^data: (.+)$/m.exec(frame)?.[1];
              if (!data) continue;
              const value = JSON.parse(data);
              if (event === "board") query.setQueryData(key, value);
              else if (event === "counters") query.setQueryData(key, (old: object | undefined) => old ? { ...old, ...value, unchanged: false } : old);
              else if (event === "unavailable") void query.invalidateQueries({ queryKey: key });
            }
          }
        } catch { if (controller.signal.aborted) break; }
        setLive(false);
        await new Promise<void>(resolve => setTimeout(resolve, 3000));
      }
    }
    void listen();
    return () => controller.abort();
  }, [query, transport]);
  return <QueryClientProvider client={query}><WebContext.Provider value={context}><BoardLiveContext.Provider value={live}>
    <WebQuestions /><div data-live-channel={live ? "connected" : "disconnected"} style={{ display: "flex", flexDirection: "column", height: "100vh", background: theme.colors.surface0, color: theme.colors.foreground }}>
      {settings && <button onClick={() => setSettings(false)}>Back to board</button>}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>{settings ? <QueueSettingsScreen theme={theme} layout={{ compact: false }} /> : <MainSurface theme={theme} layout={{ compact: false }} />}</div>
    </div>
  </BoardLiveContext.Provider></WebContext.Provider></QueryClientProvider>;
}
