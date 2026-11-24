import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  inboxLayout,
  inboxListWidth,
  inboxMenuWidth,
} from "../../shared/inbox-board";
import { BoardCardVariantContext } from "../board/cards";
import { RustListRows } from "../board/inbox-list";
import {
  InboxMenu,
  type BoardView,
  type InboxMenuCounts,
} from "../board/inbox-menu";
import { Button, DropdownSelect, muted, row } from "../controls";
import { roles, space, type as typeScale } from "../design";
import { PopoverHost } from "../popover";
import { RustTaskDialog } from "../task/rust-task";
import { EngineSettings } from "./engine-settings";
import { settingsKey } from "./engine-settings-api";
import { engineBoardTheme } from "./theme";
import {
  createPushInvalidator,
  createRustInvalidator,
  groupRustTasks,
  listenForRustChanges,
  useRustTasks,
  type RustBoardView,
} from "./rust-board";

const c = engineBoardTheme.colors;
const palette = roles(c);
const counts: InboxMenuCounts = {
  needs: 0,
  queue: 0,
  working: 0,
  review: 0,
  closing: 0,
  planning: 0,
  leads: 0,
  papercuts: 0,
};

export function EngineApp({ canEditSettings }: { canEditSettings: boolean }) {
  const [query] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={query}>
      <EngineSurface canEditSettings={canEditSettings} />
    </QueryClientProvider>
  );
}

function EngineSurface({ canEditSettings }: { canEditSettings: boolean }) {
  const client = useQueryClient();
  const invalidate = useMemo(() => createRustInvalidator(client), [client]);
  const invalidateSettings = useMemo(
    () => createPushInvalidator(client),
    [client],
  );
  const [connection, setConnection] = useState<
    "connecting" | "live" | "retrying" | "expired"
  >("connecting");
  const [settings, setSettings] = useState(
    window.location.pathname === "/settings",
  );
  const navigate = (toSettings: boolean) => {
    window.history.pushState(null, "", toSettings ? "/settings" : "/");
    setSettings(toSettings);
  };
  useEffect(() => {
    const controller = new AbortController();
    void listenForRustChanges(invalidate, controller.signal, {
      settingsChanged: () => invalidateSettings({ queryKey: settingsKey }),
      connection: setConnection,
    });
    return () => controller.abort();
  }, [invalidate, invalidateSettings]);
  useEffect(() => {
    const readLocation = () =>
      setSettings(window.location.pathname === "/settings");
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);
  return (
    <div
      data-live-channel={connection}
      style={{
        colorScheme: "dark",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: palette.canvas,
        color: palette.foreground,
      }}
    >
      {connection === "retrying" && (
        <p role="status" style={{ color: c.statusWarning, margin: space.sm }}>
          Reconnecting to the engine…
        </p>
      )}
      {connection === "expired" ? (
        <p role="alert" style={{ margin: space.md }}>
          Open a fresh board link using nucleus-engine ui.
        </p>
      ) : (
        <PopoverHost>
          {settings ? (
            <EngineSettings
              c={c}
              canEdit={canEditSettings}
              onBack={() => navigate(false)}
            />
          ) : (
            <EngineBoard
              invalidate={invalidate}
              openSettings={() => navigate(true)}
            />
          )}
        </PopoverHost>
      )}
    </div>
  );
}

function EngineBoard({
  invalidate,
  openSettings,
}: {
  invalidate: ReturnType<typeof createRustInvalidator>;
  openSettings: () => void;
}) {
  const { width } = useWindowDimensions();
  const layout = inboxLayout(width);
  const wide = layout === "wide";
  const narrow = layout === "narrow";
  const tasks = useRustTasks(true);
  const [view, setView] = useState<RustBoardView>("needs");
  const [repository, setRepository] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const repositories = useMemo(
    () =>
      [...new Set(tasks.data?.map((task) => task.identity.repository))].sort(),
    [tasks.data],
  );
  const filtered = useMemo(
    () =>
      tasks.data &&
      groupRustTasks(
        repository
          ? tasks.data.filter((task) => task.identity.repository === repository)
          : tasks.data,
      ),
    [tasks.data, repository],
  );
  const totals = filtered && {
    needs: filtered.needs.length,
    queue: filtered.queue.length,
    working: filtered.working.length,
    review: filtered.review.length,
    merging: filtered.merging.length,
    closing: filtered.closing.length,
    history: filtered.history.length,
  };
  const active = filtered?.[view];
  const selectView = (next: BoardView) => {
    if (next === "planning" || next === "leads" || next === "papercuts") return;
    setView(next);
    setSelected(null);
    setMenuOpen(false);
  };
  const menu = (
    <InboxMenu
      c={c}
      loaded={Boolean(filtered)}
      counts={counts}
      view={view}
      standalone
      rust={{ totals: totals ?? {} }}
      onSelect={selectView}
    />
  );
  const detail = selected && (
    <RustTaskDialog
      key={selected}
      id={selected}
      summary={tasks.data?.find((task) => task.identity.id === selected)}
      inline={wide}
      compact={!wide}
      c={c}
      onClose={() => setSelected(null)}
      invalidate={invalidate}
    />
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          padding: space.sm,
          backgroundColor: palette.header,
        }}
      >
        <View style={{ ...row, gap: space.sm }}>
          {narrow && (
            <Button
              c={c}
              small
              iconOnly
              icon="Menu"
              text="Menu"
              onPress={() => setMenuOpen(true)}
            />
          )}
          <Text
            accessibilityRole="header"
            style={{ ...typeScale.heading, color: c.foreground }}
          >
            Nucleus
          </Text>
        </View>
        <View style={row}>
          {repositories.length > 1 && (
            <DropdownSelect
              c={c}
              label="Repository"
              compact
              value={repository}
              options={[
                { value: "", label: "All repositories" },
                ...repositories.map((value) => ({ value, label: value })),
              ]}
              onChange={(value) => {
                setRepository(value);
                setSelected(null);
              }}
            />
          )}
          <Button
            c={c}
            small
            icon="Settings"
            text="Settings"
            onPress={openSettings}
          />
        </View>
      </View>
      <View
        style={{
          ...row,
          alignItems: "stretch",
          flexWrap: "nowrap",
          flex: 1,
          minHeight: 0,
        }}
      >
        {!narrow && (
          <View
            style={{
              width: inboxMenuWidth[wide ? "wide" : "medium"],
              backgroundColor: palette.navigation,
            }}
          >
            {menu}
          </View>
        )}
        <View
          style={{
            width: wide ? inboxListWidth : undefined,
            flex: wide ? 0 : 1,
            backgroundColor: palette.list,
          }}
        >
          <ScrollView contentContainerStyle={{ padding: space.xs }}>
            <BoardCardVariantContext.Provider value="row">
              <RustListRows
                key={view + repository}
                c={c}
                view={view}
                rust={{
                  tasks: active,
                  error: tasks.error,
                  retry: () => void tasks.refetch(),
                  selected,
                  onSelect: setSelected,
                  projectName: (task) => task.identity.repository,
                }}
              />
            </BoardCardVariantContext.Provider>
            {active?.length === 0 && (
              <Text style={{ ...muted(c), padding: space.md }}>
                No tasks in this view.
              </Text>
            )}
          </ScrollView>
        </View>
        {wide && <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>}
      </View>
      {!wide && detail}
      <Modal
        visible={narrow && menuOpen}
        animationType="none"
        onRequestClose={() => setMenuOpen(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: palette.navigation,
            padding: space.sm,
          }}
        >
          <Button
            c={c}
            small
            text="Close menu"
            onPress={() => setMenuOpen(false)}
          />
          {menu}
        </View>
      </Modal>
    </View>
  );
}
