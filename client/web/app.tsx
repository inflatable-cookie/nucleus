import { BoardLiveContext } from "../board-live";
import { markBoardReconnect } from "../board-state";
import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MainSurface, registerSettingsOpener } from "../queue";
import { StandaloneSettingsScreen } from "../settings-screen";
import { hintSettingsSection } from "../settings-hint";
import { WebContext } from "./shell";
import { WebQuestions } from "./questions";
import { createWebTransport } from "./transport";
import {
  applyLiveUpdate,
  decodeLiveFrame,
  readLiveFrames,
} from "./live-channel";
import { errorText } from "../error-text";
import { useWebTheme } from "./theme";

export function WebApp() {
  const { appearance, theme } = useWebTheme();
  const [live, setLive] = useState(false);
  // The live channel's last failure. A stream that drops reconnects below, and
  // the reader says why in the meantime instead of failing silently.
  const [liveError, setLiveError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const transport = useMemo(() => createWebTransport(), []);
  const query = useMemo(() => new QueryClient(), []);
  const context = useMemo(
    () => ({ transport, settings }),
    [transport, settings],
  );
  useEffect(() => {
    registerSettingsOpener((section) => {
      if (section) hintSettingsSection(section);
      setSettings(true);
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function listen() {
      let reconnecting = false;
      while (!controller.signal.aborted) {
        try {
          const response = await transport.events(controller.signal);
          if (!response.ok || !response.body)
            throw new Error(`Live channel: ${response.status}`);
          if (reconnecting) {
            markBoardReconnect(query);
            reconnecting = false;
          }
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
              if (update.kind === "refused") {
                setLiveError(update.reason);
                continue;
              }
              applyLiveUpdate(query, update);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          setLiveError(errorText(error));
        }
        reconnecting = true;
        setLive(false);
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      }
    }
    void listen();
    return () => controller.abort();
  }, [query, transport]);
  return (
    <QueryClientProvider client={query}>
      <WebContext.Provider value={context}>
        <BoardLiveContext.Provider value={live}>
          <WebQuestions />
          <div
            data-live-channel={live ? "connected" : "disconnected"}
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100vh",
              width: "100%",
              overflowX: "auto",
              colorScheme: appearance,
              background: theme.colors.surface0,
              color: theme.colors.foreground,
            }}
          >
            {liveError && (
              <p
                role="alert"
                data-live-error
                style={{
                  margin: 0,
                  padding: "6px 12px",
                  background: theme.colors.surface2,
                  color: theme.colors.statusWarning,
                }}
              >{`Live channel: ${liveError}. Retrying.`}</p>
            )}
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
              {settings ? (
                <StandaloneSettingsScreen
                  theme={theme}
                  layout={{ compact: false }}
                  onBack={() => setSettings(false)}
                />
              ) : (
                <MainSurface theme={theme} layout={{ compact: false }} />
              )}
            </div>
          </div>
        </BoardLiveContext.Provider>
      </WebContext.Provider>
    </QueryClientProvider>
  );
}
