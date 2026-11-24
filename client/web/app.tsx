import { BoardLiveContext } from "../board-live";
import { markBoardReconnect } from "../board-state";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MainSurface, registerSettingsOpener } from "../queue";
import { StandaloneSettingsScreen } from "../settings-screen";
import { hintSettingsSection } from "../settings-hint";
import {
  EngineFeaturesContext,
  RUST_ENGINE_FEATURES,
  TYPESCRIPT_ENGINE_FEATURES,
} from "../engine-features";
import { WebContext } from "./shell";
import { WebQuestions } from "./questions";
import { createWebTransport, type BoardTransport } from "./transport";
import {
  applyLiveUpdate,
  decodeLiveFrame,
  readLiveFrames,
} from "./live-channel";
import { errorText } from "../error-text";
import { useWebTheme } from "./theme";
import {
  createPushInvalidator,
  createRustInvalidator,
  listenForRustChanges,
} from "./rust-board";
import { createRustAdapter } from "./rust-adapter";
import { boardThemeFromT3 } from "../../hosts/t3code/board-theme";

/**
 * The web board. The TypeScript service serves it with `createWebTransport`;
 * the Rust engine serves the same app with its data adapter (Spec 070,
 * ruling 4), so both engines share every screen.
 */
export function WebApp({
  rustBoard = false,
  engine = "typescript",
}: {
  /** The TypeScript transition board that also lists Rust tasks. */
  rustBoard?: boolean;
  engine?: "typescript" | "rust";
}) {
  const rust = engine === "rust";
  const adapter = useMemo(() => (rust ? createRustAdapter() : null), [rust]);
  const [themeRevision, setThemeRevision] = useState(0);
  const readRustTheme = useCallback(
    async (signal: AbortSignal) => {
      if (!adapter) return null;
      const inputs = await adapter.rust.theme();
      void signal;
      return inputs.theme ? boardThemeFromT3(inputs.theme) : null;
    },
    [adapter],
  );
  const { appearance, theme } = useWebTheme(
    rust ? readRustTheme : undefined,
    themeRevision,
  );
  const [live, setLive] = useState(false);
  // The live channel's last failure. A stream that drops reconnects below, and
  // the reader says why in the meantime instead of failing silently.
  const [liveError, setLiveError] = useState<string | null>(null);
  const [settings, setSettings] = useState(
    rust && window.location.pathname === "/settings",
  );
  const transport = useMemo<BoardTransport>(
    () => adapter ?? createWebTransport(),
    [adapter],
  );
  const query = useMemo(() => new QueryClient(), []);
  const invalidateRust = useMemo(() => createRustInvalidator(query), [query]);
  const context = useMemo(
    () => ({ transport, settings }),
    [transport, settings],
  );
  const openSettings = useCallback(
    (open: boolean) => {
      if (rust) window.history.pushState(null, "", open ? "/settings" : "/");
      setSettings(open);
    },
    [rust],
  );
  useEffect(() => {
    if (!rust) return;
    const readLocation = () =>
      setSettings(window.location.pathname === "/settings");
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, [rust]);
  useEffect(() => {
    registerSettingsOpener((section) => {
      if (section) hintSettingsSection(section);
      openSettings(true);
    });
  }, [openSettings]);
  // The TypeScript transition board lists Rust tasks beside its own.
  useEffect(() => {
    if (!rustBoard || rust) return;
    const controller = new AbortController();
    void listenForRustChanges(invalidateRust, controller.signal);
    return () => controller.abort();
  }, [rustBoard, rust, invalidateRust]);
  // The Rust engine pushes task and settings invalidations; every board read
  // goes through the adapter again, never by polling.
  useEffect(() => {
    if (!rust) return;
    const controller = new AbortController();
    const invalidateBoard = createPushInvalidator(query);
    void listenForRustChanges(
      (id) => {
        invalidateRust(id);
        invalidateBoard({ queryKey: ["nucleus"] });
      },
      controller.signal,
      {
        settingsChanged: () => invalidateBoard({ queryKey: ["nucleus"] }),
        themeChanged: () => setThemeRevision((value) => value + 1),
        catalogChanged: () => {
          invalidateBoard({ queryKey: ["nucleus", "profile-vocabulary"] });
          invalidateBoard({ queryKey: ["nucleus", "profiles", "compatibility"] });
        },
        connection: (state) => {
          setLive(state === "live");
          setLiveError(
            state === "expired"
              ? "The board link expired. Open a fresh one using nucleus-engine ui"
              : state === "retrying"
                ? "Reconnecting to the engine"
                : null,
          );
        },
      },
    );
    return () => controller.abort();
  }, [rust, query, invalidateRust]);
  useEffect(() => {
    if (rust) return;
    const web = transport as ReturnType<typeof createWebTransport>;
    const controller = new AbortController();
    async function listen() {
      let reconnecting = false;
      while (!controller.signal.aborted) {
        try {
          const response = await web.events(controller.signal);
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
  }, [rust, query, transport]);
  useEffect(() => {
    document.documentElement.style.colorScheme = appearance;
    document.body.style.background = theme.colors.surface0;
  }, [appearance, theme]);
  return (
    <QueryClientProvider client={query}>
      <EngineFeaturesContext.Provider
        value={rust ? RUST_ENGINE_FEATURES : TYPESCRIPT_ENGINE_FEATURES}
      >
        <WebContext.Provider value={context}>
          <BoardLiveContext.Provider value={live}>
            {!rust && <WebQuestions />}
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
                >
                  {rust ? `${liveError}.` : `Live channel: ${liveError}. Retrying.`}
                </p>
              )}
              <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {settings ? (
                  <StandaloneSettingsScreen
                    theme={theme}
                    layout={{ compact: false }}
                    onBack={() => openSettings(false)}
                  />
                ) : (
                  <MainSurface
                    theme={theme}
                    layout={{ compact: false }}
                    rustBoard={rustBoard || rust ? invalidateRust : undefined}
                  />
                )}
              </div>
            </div>
          </BoardLiveContext.Provider>
        </WebContext.Provider>
      </EngineFeaturesContext.Provider>
    </QueryClientProvider>
  );
}
