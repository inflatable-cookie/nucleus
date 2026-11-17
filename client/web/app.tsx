import { BoardLiveContext } from "../board-live";
import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MainSurface, registerSettingsOpener } from "../queue";
import { QueueSettingsScreen } from "../settings-screen";
import { hintSettingsSection } from "../settings-hint";
import { WebContext } from "./shell";
import { WebQuestions } from "./questions";
import { createWebTransport, scheduleWebTokenRenewal } from "./transport";
import { applyLiveUpdate, decodeLiveFrame, readLiveFrames } from "./live-channel";
import { errorText } from "../error-text";
import type { BoardTheme } from "../shell/types";

const theme: BoardTheme = { colors: { surface0: "#111318", surface1: "#1a1d24", surface2: "#252932", border: "#39404b", foreground: "#f1f3f5", foregroundMuted: "#a5acb8", accent: "#8caaff", accentForeground: "#101521", statusSuccess: "#71c99a", statusWarning: "#e9bc68", statusDanger: "#ef8282" } };

export function WebApp({ token: initialToken, expiresAt: initialExpiry }: { token: string; expiresAt: number }) {
  const [session, setSession] = useState({ token: initialToken, expiresAt: initialExpiry });
  const [live, setLive] = useState(false);
  // The live channel's last failure. A stream that drops reconnects below, and
  // the reader says why in the meantime instead of failing silently.
  const [liveError, setLiveError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const transport = useMemo(() => createWebTransport(session.token), [session.token]);
  const query = useMemo(() => new QueryClient(), []);
  const context = useMemo(() => ({ transport, settings }), [transport, settings]);
  useEffect(() => { registerSettingsOpener(section => { if (section) hintSettingsSection(section); setSettings(true); }); }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const schedule = () => {
      timer = scheduleWebTokenRenewal(session.expiresAt, async () => {
        try {
          const renewed = await transport.renew();
          if (!cancelled) setSession(renewed);
        } catch (error) {
          if (cancelled) return;
          setLiveError(errorText(error));
          // Keep trying while the current credential is valid; revoke and restart
          // remain terminal because the authenticated renewal route refuses them.
          if (Date.now() < session.expiresAt) timer = setTimeout(schedule, Math.min(3000, session.expiresAt - Date.now()));
        }
      });
    };
    schedule();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [transport, session.expiresAt]);
  useEffect(() => {
    const controller = new AbortController();
    async function listen() {
      while (!controller.signal.aborted) {
        try {
          const response = await transport.events(controller.signal);
          if (!response.ok || !response.body) throw new Error(`Live channel: ${response.status}`);
          setLive(true);
          setLiveError(null);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const read = readLiveFrames(pending);
            pending = read.rest;
            for (const frame of read.frames) {
              const update = decodeLiveFrame(frame);
              if (update.kind === "refused") { setLiveError(update.reason); continue; }
              applyLiveUpdate(query, update);
            }
          }
        } catch (error) { if (controller.signal.aborted) break; setLiveError(errorText(error)); }
        setLive(false);
        await new Promise<void>(resolve => setTimeout(resolve, 3000));
      }
    }
    void listen();
    return () => controller.abort();
  }, [query, transport]);
  return <QueryClientProvider client={query}><WebContext.Provider value={context}><BoardLiveContext.Provider value={live}>
    <WebQuestions /><div data-live-channel={live ? "connected" : "disconnected"} style={{ display: "flex", flexDirection: "column", height: "100vh", background: theme.colors.surface0, color: theme.colors.foreground }}>
      {liveError && <p role="alert" data-live-error style={{ margin: 0, padding: "6px 12px", background: theme.colors.surface2, color: theme.colors.statusWarning }}>{`Live channel: ${liveError}. Retrying.`}</p>}
      {settings && <button onClick={() => setSettings(false)}>Back to board</button>}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>{settings ? <QueueSettingsScreen theme={theme} layout={{ compact: false }} /> : <MainSurface theme={theme} layout={{ compact: false }} />}</div>
    </div>
  </BoardLiveContext.Provider></WebContext.Provider></QueryClientProvider>;
}
