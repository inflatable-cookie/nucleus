import { RUST_PROFILE_USAGE_KEY, rustProfileUsage } from "./rust-contracts";
import { errorText, errorText as failureText } from "./error-text";
import { activeGroupLimit } from "../shared/pool";
import { ProfilesPanel } from "./settings-profiles";
export {
  plainWords,
  hostCompatibilityNote,
  catalogAge,
} from "./settings-profile-helpers";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  replaceEqualDeep,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRpc, type BoardSurfaceProps } from "./shell";
import {
  ActionButton,
  Button,
  StatusGlyph,
  Disclosure,
  DropdownSelect,
  Field,
  FieldCaption,
  LabelHelp,
  NumberStepper,
  Section,
  StopSlider,
  TabRow,
  controlText,
  muted,
  row,
  type Colors,
} from "./controls";
import { control, space, type as typeScale, radius } from "./design";
import { PopoverHost } from "./popover";
import { BOARD_STATE_KEY, useBoardState } from "./board-state";
import * as api from "../shared/contracts";
import {
  BACKUP_STALE_AFTER_MS,
  type PoolEntry,
  type Profile,
  type RepositorySettings,
  type UiQueueState,
} from "../shared/contracts";
import { settingsViews } from "../shared/queue-navigation";
import { useSettingsSection } from "./settings-hint";
import { SettingsTelemetry } from "./settings-telemetry";
import { BackupsPanel } from "./backups-panel";
import { StoragePanel } from "./storage-settings";
import { DispatchLimits, type PendingOverrideRemovalPhase } from "./limits";
import { HostsPanel } from "./hosts-settings";
import { ProjectsSection } from "./projects-settings";
import { GitHubReviewerSettings } from "./web/github-reviewer-settings";
import { DevicesSettings } from "./web/device-pairing";
/** A board from a service that predates Spec 052 carries no dispatch routing policy. */

/**
 * Queue's native Paseo settings screen (Spec 026 / nucleus#934): Dispatch limits,
 * Hosts (nucleus#1325), Profiles (with Subscriptions beneath them, nucleus#963), Projects, Backups and
 * Telemetry live here, one row of tabs at every width.
 * The header's Settings icon opens this screen through `openSettings`; the board
 * chooser's settings icon opens it at Projects through the section hint.
 */
export function QueueSettingsScreen({ theme }: BoardSurfaceProps) {
  const c = theme.colors;
  const [width, setWidth] = useState(0);
  // The layout follows the measured width of the Settings screen itself, never the
  // host's compact flag (task 923). The tabs are the same at every width
  // (nucleus#963); compact only tightens the inset and the panels inside.
  const compact = width > 0 && width < 700;
  const inset = compact ? 16 : 24;
  const { stateQuery, state } = useBoardState();
  const canManageGitHub = state?.canEditSettings === true;
  const fetchRepositories = useRpc(api.repositories);
  const fetchProjectSettings = useRpc(api.projectSettings),
    upsertProject = useRpc(api.projectUpsert);
  const setProjectPlanner = useRpc(api.projectSetPlanner);
  const setProfile = useRpc(api.configureProfile),
    setPool = useRpc(api.configurePool),
    setAvailability = useRpc(api.availabilityControl),
    setUsage = useRpc(api.configureUsage),
    setCapacity = useRpc(api.configureCapacity),
    setRepository = useRpc(api.repositorySet),
    setProjectLimit = useRpc(api.configureProjectDispatchLimit);
  const fetchBackups = useRpc(api.backupList),
    makeBackup = useRpc(api.backupNow);
  const fetchWorkStorage = useRpc(api.workStorage),
    saveWorkStorage = useRpc(api.saveWorkStorage);
  const repositoryBlockers = useRpc(api.projectRemovalBlockers),
    removeProjectRepository = useRpc(api.projectRemoveRepository),
    mergeProject = useRpc(api.projectMerge),
    mergeCheck = useRpc(api.projectMergeCheck);
  const previewRemoval = useRpc(api.projectManagementPreview),
    removeProject = useRpc(api.projectManage);
  const queryClient = useQueryClient();
  const [settingsTab, setSettingsTab] = useSettingsSection("capacity");
  const fetchProfileUsage = useRpc(rustProfileUsage);
  const profileUsageQuery = useQuery({
    queryKey: RUST_PROFILE_USAGE_KEY,
    queryFn: () => fetchProfileUsage({}),
    enabled: settingsTab === "profiles",
  });
  const profileUsage = profileUsageQuery.data;
  const profileState =
    state && profileUsage
      ? {
          ...state,
          ...profileUsage,
          availability: [
            ...state.availability,
            ...profileUsage.availability.filter(
              ({ group }) =>
                !state.availability.some((entry) => entry.group === group),
            ),
          ],
        }
      : state;
  const repositoriesQuery = useQuery({
    queryKey: ["nucleus", "repositories"],
    queryFn: () => fetchRepositories({}),
    enabled: settingsTab === "profiles",
  });
  // The list is saved data only: it never waits on a host.
  const projectsQuery = useQuery({
    queryKey: ["nucleus", "project-settings"],
    queryFn: () => fetchProjectSettings({}),
    enabled: settingsTab === "projects",
  });
  // The project open in the editor, and only it, gets its live planner, agent and
  // responsible-thread state. Its key is cleared when the tab changes away.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (settingsTab !== "projects") setFocusKey(null);
  }, [settingsTab]);
  const focusQuery = useQuery({
    queryKey: ["nucleus", "project-settings", "focus", focusKey],
    queryFn: () => fetchProjectSettings({ project: focusKey! }),
    enabled: settingsTab === "projects" && focusKey !== null,
  });
  // Spec 028: the listing is a Backups-tab read. The stale/failing warning on every
  // other tab rides the board's snapshot health, so no surface polls this just to age a
  // snapshot (2026-10-25 performance audit: the poll spawned a Node process per minute).
  const backupsQuery = useQuery({
    queryKey: ["nucleus", "backups"],
    queryFn: () => fetchBackups({}),
    enabled: settingsTab === "backups",
    refetchInterval: 60_000,
  });
  // Rust Settings also uses this read for the backup health notice above its tabs.
  const storageQuery = useQuery({
    queryKey: ["nucleus", "work-storage"],
    queryFn: () => fetchWorkStorage({}),
    enabled: true,
  });
  // Settings-only capacity writes need the values in force and the record of
  // applied changes. It is a separate read because the board projection keeps its
  // shape (service-boundary contract).
  const fetchCapacityState = useRpc(api.capacityState);
  const capacityStateQuery = useQuery({
    queryKey: ["nucleus", "capacity-state"],
    queryFn: () => fetchCapacityState({}),
    enabled: settingsTab === "capacity" || settingsTab === "hosts",
  });
  const fetchCatalog = useRpc(api.readProfileVocabulary);
  const catalogQuery = useQuery({
    queryKey: ["nucleus", "profile-vocabulary", ""],
    queryFn: () => fetchCatalog({}),
    enabled:
      settingsTab === "capacity" &&
      Boolean(capacityStateQuery.data?.plannerModel),
    staleTime: 30_000,
  });
  // Settings → Hosts (nucleus#1325): the catalogue with status and dependents, refreshed while open.
  const fetchHosts = useRpc(api.hostList),
    removeHost = useRpc(api.hostRemove);
  const hostsQuery = useQuery({
    queryKey: ["nucleus", "hosts"],
    queryFn: () => fetchHosts({}),
    enabled: settingsTab === "hosts",
  });
  const listedNewest = backupsQuery.data?.snapshots
    .filter((entry) => entry.verified)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const rustBackups = storageQuery.data?.backups;
  const newestBackupAt =
    rustBackups?.newestAt ??
    state?.backup?.newestSnapshotAt ??
    listedNewest?.at ??
    null;
  const backupAgeMs = newestBackupAt
    ? Date.now() - Date.parse(newestBackupAt)
    : Infinity;
  const backupStale = backupAgeMs > BACKUP_STALE_AFTER_MS;
  const backupError =
    (rustBackups?.issues ?? 0) > 0
      ? "Some backups could not be verified."
      : null;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<{
    profileId: string;
    message: string;
  } | null>(null);
  const dismissibleError = error || profileSaveError?.message;
  const [pendingOverrideRemovals, setPendingOverrideRemovals] = useState<
    Record<string, PendingOverrideRemovalPhase>
  >({});
  const setRemovalPhase = (
    projectKey: string,
    phase: PendingOverrideRemovalPhase | null,
  ) =>
    setPendingOverrideRemovals((prev) => {
      if (phase === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, projectKey))
          return prev;
        const { [projectKey]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [projectKey]: phase };
    });
  // Dispatch limits save as they change (Tom, 2026-10-22: "auto save rather than
  // needing manual save buttons"): the write, then a fresh board. A failure throws
  // to the section's autosave, which shows it beside the control.
  async function persist(fn: () => Promise<unknown>): Promise<void> {
    await fn();
    await queryClient.refetchQueries({
      queryKey: ["nucleus", "state"],
      exact: true,
    });
  }
  async function saveProjectLimit(value: {
    projectKey: string;
    limit: number | null;
  }): Promise<void> {
    if (value.limit !== null) {
      await persist(() => setProjectLimit(value));
      await queryClient.invalidateQueries({
        queryKey: ["nucleus", "project-settings"],
      });
      return;
    }
    setRemovalPhase(value.projectKey, "saving");
    try {
      await setProjectLimit(value);
    } catch (failure) {
      setRemovalPhase(value.projectKey, null);
      throw failure;
    }
    setRemovalPhase(value.projectKey, "refreshing");
    try {
      await queryClient.refetchQueries(
        { queryKey: ["nucleus", "state"], exact: true },
        { throwOnError: true },
      );
      await queryClient.invalidateQueries({
        queryKey: ["nucleus", "project-settings"],
      });
    } catch (refreshFailure) {
      setError(
        `Override removed, but refresh failed: ${errorText(refreshFailure)}`,
      );
    } finally {
      setRemovalPhase(value.projectKey, null);
    }
  }
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await fn();
      await queryClient.refetchQueries({
        queryKey: ["nucleus", "state"],
        exact: true,
      });
      await queryClient.refetchQueries({
        queryKey: ["nucleus", "repositories"],
        exact: true,
      });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Every popover on the screen renders in this host's layer, above the sections (Tom, 2026-11-08).
  return (
    <PopoverHost style={{ width: "100%" }}>
      <View
        accessibilityLabel="Nucleus settings"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{
          flex: 1,
          width: "100%",
          minWidth: 0,
          minHeight: 0,
          backgroundColor: c.surface0,
          paddingTop: inset,
          gap: space.md,
        }}
      >
        {(dismissibleError || stateQuery.error || state?.error) && (
          <View style={{ ...row, flexWrap: "nowrap" }}>
            <Text
              accessibilityRole="alert"
              style={{ color: c.statusDanger, flex: 1 }}
            >
              {dismissibleError || String(stateQuery.error || state?.error)}
            </Text>
            {dismissibleError && (
              <ActionButton
                c={c}
                action="close"
                label="Dismiss error"
                onPress={() => {
                  if (error) setError("");
                  else setProfileSaveError(null);
                }}
              />
            )}
          </View>
        )}
        {/* Six short tabs fit one line at Paseo's 640–700 point settings column (nucleus#963). */}
        <TabRow
          c={c}
          label="Settings sections"
          nowrap
          tabs={settingsViews
            .map((view) => ({
              id: view.id,
              text: view.short,
              label: view.label,
            }))
            .filter(
              // Rust engine (Spec 070 rulings 16 and 17): no Telemetry, backups live in Storage.
              (tab) =>
                tab.id !== "backups" &&
                tab.id !== "telemetry" &&
                (tab.id !== "github-accounts" || canManageGitHub),
            )}
          value={settingsTab}
          onChange={setSettingsTab}
        />
        <View style={{ flex: 1, minWidth: 0, minHeight: 0, gap: space.sm }}>
          {settingsTab !== "backups" && (backupStale || backupError) && (
            <View style={row}>
              {backupError ? (
                <LabelHelp
                  c={c}
                  label="Backups are failing"
                  text={backupError}
                  color={c.statusWarning}
                />
              ) : (
                <Text
                  accessibilityRole="alert"
                  style={{ color: c.statusWarning, flexShrink: 1 }}
                >
                  {newestBackupAt
                    ? `Newest verified backup ${Math.floor(backupAgeMs / 60000)} min ago`
                    : "No verified backup yet"}
                </Text>
              )}
              <Button
                c={c}
                small
                text="Open Storage"
                onPress={() => setSettingsTab("storage")}
              />
            </View>
          )}
          {settingsTab === "profiles" && (
            <ProfilesPanel
              c={c}
              compact={compact}
              inset={inset}
              state={profileState ?? null}
              stateError={stateQuery.error}
              usageReady={Boolean(profileUsage)}
              usageError={profileUsageQuery.error}
              repositories={
                Array.isArray(repositoriesQuery.data)
                  ? repositoriesQuery.data
                  : []
              }
              busy={busy}
              savePool={async (entry, groupChanged) => {
                try {
                  const expected = api.poolSchema.parse({
                    ...entry,
                    group: entry.group.trim(),
                  });
                  const saved = await setProfile({ ...expected, groupChanged });
                  const confirmed =
                    groupChanged === false && saved.entry
                      ? { ...saved.entry, group: expected.group }
                      : saved.entry;
                  if (replaceEqualDeep(expected, confirmed) !== expected)
                    throw new Error(
                      "The service could not confirm the profile settings it stored.",
                    );
                  setProfileSaveError((current) =>
                    current?.profileId === entry.profileId ? null : current,
                  );
                  void queryClient.invalidateQueries({
                    queryKey: BOARD_STATE_KEY,
                  });
                } catch (error) {
                  setProfileSaveError({
                    profileId: entry.profileId,
                    message: `Profile settings could not be saved. ${errorText(error)}`,
                  });
                  throw error;
                }
              }}
              savePoolList={(entries) => act(() => setPool({ entries }))}
              saveAvailability={(value) => act(() => setAvailability(value))}
            />
          )}
          {settingsTab === "capacity" && state && (
            <ScrollView
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{
                paddingBottom: inset,
                width: "100%",
                maxWidth: 780,
              }}
            >
              <DispatchLimits
                c={c}
                state={state}
                busy={busy}
                authority={capacityStateQuery.data}
                authorityError={capacityStateQuery.error}
                retryAuthority={() => void capacityStateQuery.refetch()}
                catalog={catalogQuery.data}
                refreshBoard={() => stateQuery.refetch()}
                saveUsage={(level, until) =>
                  persist(() => setUsage({ level, until }))
                }
                saveCapacity={(value) =>
                  persist(async () => {
                    await setCapacity(value);
                    await queryClient.refetchQueries({
                      queryKey: ["nucleus", "capacity-state"],
                      exact: true,
                    });
                  })
                }
                saveProjectLimit={saveProjectLimit}
                pendingOverrideRemovals={pendingOverrideRemovals}
              />
            </ScrollView>
          )}
          {settingsTab === "hosts" && (
            <ScrollView
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{
                paddingBottom: inset,
                width: "100%",
                maxWidth: 780,
              }}
            >
              <HostsPanel
                c={c}
                list={hostsQuery.data}
                loading={hostsQuery.isPending}
                loadError={hostsQuery.error}
                retry={() => void hostsQuery.refetch()}
                defaultValues={capacityStateQuery.data?.effective ?? null}
                saveDefaultHost={(host) =>
                  persist(async () => {
                    await setCapacity({
                      ...capacityStateQuery.data!.effective,
                      operatorDefaultHostKind: host,
                    });
                    await queryClient.refetchQueries({
                      queryKey: ["nucleus", "capacity-state"],
                      exact: true,
                    });
                    await hostsQuery.refetch();
                  })
                }
                remove={async (hostId) => {
                  try {
                    await removeHost({ hostId });
                  } finally {
                    await hostsQuery.refetch();
                  }
                }}
              />
            </ScrollView>
          )}
          {settingsTab === "projects" && (
            <ProjectsSection
              c={c}
              compact={compact}
              inset={inset}
              query={projectsQuery}
              onFocus={setFocusKey}
              edit={{
                saveProject: (input) => upsertProject(input),
                setPlanner: (input) =>
                  setProjectPlanner({ ...input, setBy: "operator" }),
                setSlots: (input) => setProjectLimit(input),
                setRepository: (input) => setRepository(input),
                repositoryBlockers: (input) => repositoryBlockers(input),
                removeRepository: (input) => removeProjectRepository(input),
                mergeCheck: (input) => mergeCheck(input),
                merge: (input) => mergeProject(input),
                removal: {
                  previewRpc: previewRemoval,
                  removeRpc: removeProject,
                },
                refresh: () =>
                  Promise.all([
                    queryClient.refetchQueries({
                      queryKey: ["nucleus", "project-settings"],
                    }),
                    queryClient.refetchQueries({
                      queryKey: ["nucleus", "state"],
                      exact: true,
                    }),
                  ]),
                focus: {
                  row: focusQuery.data?.projects[0],
                  error: focusQuery.error,
                  isPending: focusQuery.isPending,
                },
              }}
            />
          )}
          {settingsTab === "backups" && (
            <BackupsPanel
              c={c}
              inset={inset}
              list={backupsQuery.data}
              loading={backupsQuery.isPending}
              loadError={backupsQuery.error}
              health={state?.backup}
              backUp={() =>
                act(async () => {
                  await makeBackup({});
                  await backupsQuery.refetch();
                })
              }
            />
          )}
          {settingsTab === "storage" && (
            <StoragePanel
              c={c}
              inset={inset}
              state={storageQuery.data}
              loading={storageQuery.isPending}
              loadError={storageQuery.error}
              save={(input) =>
                saveWorkStorage(input).then(async (next) => {
                  queryClient.setQueryData(["nucleus", "work-storage"], next);
                  await queryClient.invalidateQueries({
                    queryKey: ["nucleus", "backups"],
                  });
                  return next;
                })
              }
            />
          )}
          {settingsTab === "github-accounts" && canManageGitHub && (
            <GitHubReviewerSettings c={c} inset={inset} />
          )}
          {settingsTab === "devices" && <DevicesSettings c={c} inset={inset} />}
          {settingsTab === "telemetry" && (
            <SettingsTelemetry c={c} compact={compact} />
          )}
        </View>
      </View>
    </PopoverHost>
  );
}

export type StandaloneSettingsScreenProps = BoardSurfaceProps & {
  onBack: () => void;
  backLabel?: string;
};

/**
 * Standalone Settings layout for route mounts that own the full viewport or
 * panel (T3's web board and BB's board-panel Settings route). Paseo and BB's
 * host-owned `settingsSection` mount `QueueSettingsScreen` directly without
 * standalone framing or a Back control.
 */
export function StandaloneSettingsScreen({
  theme,
  layout,
  navigation,
  onBack,
  backLabel = "Back to board",
}: StandaloneSettingsScreenProps) {
  const c = theme.colors;
  const [width, setWidth] = useState(0);
  const compact = width > 0 ? width < 700 : layout.compact;
  const inset = compact ? space.md : space.lg;
  return (
    <View
      accessibilityLabel="Standalone Nucleus settings"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        flex: 1,
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        backgroundColor: c.surface0,
        paddingHorizontal: inset,
        paddingTop: inset,
      }}
    >
      <View
        accessibilityLabel="Nucleus settings column"
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 780,
          alignSelf: "center",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <View
          style={{ ...row, flexWrap: "nowrap", justifyContent: "flex-start" }}
        >
          <Button
            small
            c={c}
            icon="ChevronLeft"
            text="Back to board"
            label={backLabel}
            onPress={onBack}
          />
        </View>
        <QueueSettingsScreen
          theme={theme}
          layout={{ compact }}
          navigation={navigation}
        />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------------- */
/* Spec 052 / nucleus#934: one Profiles page for stored records and dispatch  */
/* ------------------------------------------------------------------------- */
