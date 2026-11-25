import { RUST_PROFILE_USAGE_KEY } from "../rust-contracts";
import { BoardLiveContext } from "../board-live";
import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MainSurface, registerSettingsOpener } from "../queue";
import { StandaloneSettingsScreen } from "../settings-screen";
import { hintSettingsSection } from "../settings-hint";
import { EngineFeaturesContext, RUST_ENGINE_FEATURES } from "../engine-features";
import { WebContext } from "./shell";
import { useWebTheme } from "./theme";
import {
  createPushInvalidator,
  createRustInvalidator,
  listenForRustChanges,
  isRustHttpError,
} from "./rust-board";
import { createRustAdapter } from "./rust-adapter";
import { boardThemeFromT3 } from "../../hosts/t3code/board-theme";

export function WebApp() {
  const adapter = useMemo(() => createRustAdapter(), []);
  const [themeRevision, setThemeRevision] = useState(0);
  const readRustTheme = useCallback(
    async (signal: AbortSignal) => {
      const inputs = await adapter.rust.theme();
      void signal;
      return inputs.theme ? boardThemeFromT3(inputs.theme) : null;
    },
    [adapter],
  );
  const { appearance, theme } = useWebTheme(
    readRustTheme,
    themeRevision,
  );
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  // The live channel's last failure. A stream that drops reconnects below, and
  // the reader says why in the meantime instead of failing silently.
  const [liveError, setLiveError] = useState<string | null>(null);
  const [settings, setSettings] = useState(
    window.location.pathname === "/settings",
  );
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const query = useMemo(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          refetchOnWindowFocus: false,
          refetchOnReconnect: false,
          retry: (attempt, error) =>
            !isRustHttpError(error, 401) && !isRustHttpError(error, 403) && attempt < 2,
        },
      },
    }),
    [sessionEpoch],
  );
  const invalidateRust = useMemo(() => createRustInvalidator(query), [query]);
  const context = useMemo(
    () => ({ transport: adapter, settings }),
    [adapter, settings],
  );
  const openSettings = useCallback(
    (open: boolean) => {
      window.history.pushState(null, "", open ? "/settings" : "/");
      setSettings(open);
    },
    [],
  );
  useEffect(() => {
    const readLocation = () =>
      setSettings(window.location.pathname === "/settings");
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);
  useEffect(() => {
    registerSettingsOpener((section) => {
      if (section) hintSettingsSection(section);
      openSettings(true);
    });
  }, [openSettings]);
  // The Rust engine pushes task and settings invalidations; every board read
  // goes through the adapter again, never by polling.
  useEffect(() => {
    const controller = new AbortController();
    const invalidateBoard = createPushInvalidator(query);
    let initialRead = sessionEpoch === 0;
    const startReads = () => {
      if (!initialRead) return false;
      initialRead = false;
      setReady(true);
      return true;
    };
    const refreshBoard = () => {
      if (!controller.signal.aborted)
        invalidateBoard({ queryKey: ["nucleus"] });
    };
    void listenForRustChanges(
      invalidateRust,
      controller.signal,
      {
        resync: () => {
          // The initial marker starts the first reads after the subscription is open.
          if (startReads()) return;
          invalidateRust();
          void adapter.refreshSession().then((changed) => {
            if (controller.signal.aborted) return;
            if (changed) setSessionEpoch((value) => value + 1);
            else refreshBoard();
          }).catch(refreshBoard);
        },
        settingsChanged: () => {
          invalidateBoard({
            queryKey: ["nucleus"],
            predicate: ({ queryKey: [, area, detail] }) =>
              ["state", "profiles", "repositories", "project-settings", "capacity-state", "hosts"]
                .some((key) => key === area) ||
              (area === "github-accounts" && detail === "settings"),
          });
        },
        storageChanged: () => invalidateBoard({ queryKey: ["nucleus", "work-storage"] }),
        planningChanged: () => {
          invalidateBoard({
            queryKey: ["nucleus"],
            predicate: ({ queryKey: [, area] }) =>
              ["plans", "leads", "lane-document", "lead", "papercut"].some((key) => key === area),
          });
        },
        profileUsageChanged: () => invalidateBoard({ queryKey: RUST_PROFILE_USAGE_KEY }),
        decisionsChanged: () => invalidateBoard({
          queryKey: ["nucleus"],
          predicate: ({ queryKey: [, area] }) => area === "decisions" || area === "decision",
        }),
        themeChanged: () => setThemeRevision((value) => value + 1),
        catalogChanged: () => {
          invalidateBoard({ queryKey: ["nucleus", "state"] });
          invalidateBoard({ queryKey: ["nucleus", "profile-vocabulary"] });
          invalidateBoard({ queryKey: ["nucleus", "profiles", "compatibility"] });
        },
        connection: (state) => {
          if (state !== "live") startReads();
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
  }, [adapter, query, invalidateRust, sessionEpoch]);
  useEffect(() => {
    document.documentElement.style.colorScheme = appearance;
    document.body.style.background = theme.colors.surface0;
  }, [appearance, theme]);
  return (
    <QueryClientProvider key={sessionEpoch} client={query}>
      <EngineFeaturesContext.Provider
        value={RUST_ENGINE_FEATURES}
      >
        <WebContext.Provider value={context}>
          <BoardLiveContext.Provider value={live}>
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
                  {liveError}.
                </p>
              )}
              <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {!ready ? (
                  <p role="status">Connecting to the Nucleus engine…</p>
                ) : settings ? (
                  <StandaloneSettingsScreen
                    theme={theme}
                    layout={{ compact: false }}
                    onBack={() => openSettings(false)}
                  />
                ) : (
                  <MainSurface
                    theme={theme}
                    layout={{ compact: false }}
                    rustBoard={invalidateRust}
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
