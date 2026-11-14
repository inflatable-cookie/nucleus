import { errorText, errorText as failureText } from "./error-text";
import { activeGroupLimit } from "../shared/pool";
import { ProfilesPanel } from "./settings-profiles";
export { plainWords, hostCompatibilityNote, catalogAge } from "./settings-profile-helpers";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type BoardSurfaceProps } from "./shell";
import { ActionButton, Button, StatusGlyph, Disclosure, DropdownSelect, Field, FieldCaption, LabelHelp, NumberStepper, Section, StopSlider, TabRow, controlText, muted, row, type Colors } from "./controls";
import { control, space, type as typeScale, radius } from "./design";
import { PopoverHost } from "./popover";
import { useBoardState } from "./board-state";
import * as api from "../shared/contracts";
import { BACKUP_STALE_AFTER_MS, type PoolEntry, type Profile, type Project, type RepositorySettings, type UiQueueState } from "../shared/contracts";
import { settingsViews } from "../shared/queue-navigation";
import { useSettingsSection } from "./settings-hint";
import { SettingsTelemetry } from "./settings-telemetry";
import { BackupsPanel } from "./backups-panel";
import { DispatchLimits } from "./limits";
import { ProjectsSection } from "./projects-settings";
/** A board from a service that predates Spec 052 carries no usage view. */

/**
 * Queue's native Paseo settings screen (Spec 026 / nucleus#934): Dispatch limits,
 * Profiles (with Subscriptions beneath them, nucleus#963), Projects, Backups and
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
  const fetchRepositories = useRpc(api.repositories);
  const fetchProjectSettings = useRpc(api.projectSettings), upsertProject = useRpc(api.projectUpsert);
  const fetchOwnerCandidates = useRpc(api.projectOwnerCandidates), setProjectPlanner = useRpc(api.projectSetPlanner), parkProject = useRpc(api.projectPark), unparkProject = useRpc(api.projectUnpark);
  const registerProjectAgent = useRpc(api.agentRegister), unregisterProjectAgent = useRpc(api.agentUnregister);
  const setProfile = useRpc(api.configureProfile), setPool = useRpc(api.configurePool), setAvailability = useRpc(api.availabilityControl), setDemandOffsets = useRpc(api.configureDemandOffsets), setUsage = useRpc(api.configureUsage), setCapacity = useRpc(api.configureCapacity), setRepository = useRpc(api.repositorySet), setProjectLimit = useRpc(api.configureProjectDispatchLimit);
  const fetchBackups = useRpc(api.backupList), makeBackup = useRpc(api.backupNow);
  const repositoryBlockers = useRpc(api.projectRemovalBlockers), removeProjectRepository = useRpc(api.projectRemoveRepository), mergeProject = useRpc(api.projectMerge), mergeCheck = useRpc(api.projectMergeCheck);
  const previewRemoval = useRpc(api.projectManagementPreview), removeProject = useRpc(api.projectManage), resetRemoval = useRpc(api.projectResetCancellation);
  const cancelTasks = useRpc(api.bulkDisposition), cancellationReceipt = useRpc(api.bulkDispositionDetail);
  const queryClient = useQueryClient();
  const [settingsTab, setSettingsTab] = useSettingsSection("capacity");
  const repositoriesQuery = useQuery({ queryKey: ["nucleus", "repositories"], queryFn: () => fetchRepositories({}), enabled: settingsTab === "profiles" });
  const projectsQuery = useQuery({ queryKey: ["nucleus", "project-settings"], queryFn: () => fetchProjectSettings({}), enabled: settingsTab === "projects" });
  // The planner picker's live threads; task threads are left out by `kind` in the picker.
  const candidatesQuery = useQuery({ queryKey: ["nucleus", "owner-candidates"], queryFn: () => fetchOwnerCandidates({}), enabled: settingsTab === "projects" });
  // Spec 028: the listing is a Backups-tab read. The stale/failing warning on every
  // other tab rides the board's snapshot health, so no surface polls this just to age a
  // snapshot (2026-10-25 performance audit: the poll spawned a Node process per minute).
  const backupsQuery = useQuery({ queryKey: ["nucleus", "backups"], queryFn: () => fetchBackups({}), enabled: settingsTab === "backups", refetchInterval: 60_000 });
  // Settings-only capacity writes need the values in force and the record of
  // applied changes. It is a separate read because the board projection keeps its
  // shape (service-boundary contract).
  const fetchCapacityState = useRpc(api.capacityState);
  const capacityStateQuery = useQuery({ queryKey: ["nucleus", "capacity-state"], queryFn: () => fetchCapacityState({}), enabled: settingsTab === "capacity" });
  const listedNewest = backupsQuery.data?.snapshots.filter(entry => entry.verified).sort((a,b) => b.at.localeCompare(a.at))[0];
  const newestBackupAt = state?.backup?.newestSnapshotAt ?? listedNewest?.at ?? null;
  const backupAgeMs = newestBackupAt ? Date.now() - Date.parse(newestBackupAt) : Infinity;
  const backupStale = backupAgeMs > BACKUP_STALE_AFTER_MS;
  const backupError = state?.backup?.localError ?? backupsQuery.data?.localError ?? null;
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  // Dispatch limits save as they change (Tom, 2026-10-22: "auto save rather than
  // needing manual save buttons"): the write, then a fresh board. A failure throws
  // to the section's autosave, which shows it beside the control.
  async function persist(fn: () => Promise<unknown>): Promise<void> {
    await fn();
    await queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true });
  }
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError("");
    try {
      await fn();
      await queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true });
      await queryClient.refetchQueries({ queryKey: ["nucleus", "repositories"], exact: true });
      return true;
    }
    catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  }
  // Every popover on the screen renders in this host's layer, above the sections (Tom, 2026-11-08).
  return <PopoverHost style={{ width: "100%" }}><View accessibilityLabel="Nucleus settings" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, width: "100%", minWidth: 0, minHeight: 0, backgroundColor: c.surface0, paddingTop: inset, gap: space.md }}>
    {(error || stateQuery.error || state?.error) && <View style={{ ...row, flexWrap: "nowrap" }}><Text accessibilityRole="alert" style={{ color: c.statusDanger, flex: 1 }}>{error || String(stateQuery.error || state?.error)}</Text>
      {error && <ActionButton c={c} action="close" label="Dismiss error" onPress={() => setError("")} />}</View>}
    {/* Five short tabs fit one line at Paseo's 640–700 point settings column (nucleus#963). */}
    <TabRow c={c} label="Settings sections" nowrap tabs={settingsViews.map(view => ({ id: view.id, text: view.short, label: view.label }))} value={settingsTab} onChange={setSettingsTab} />
    <View style={{flex:1, minWidth:0, minHeight:0, gap:space.sm}}>
    {settingsTab !== "backups" && (backupStale || backupError) &&
      <View style={row}>
        {backupError
          ? <LabelHelp c={c} label="Backups are failing" text={backupError} color={c.statusWarning} />
          : <Text accessibilityRole="alert" style={{ color: c.statusWarning, flexShrink: 1 }}>{newestBackupAt ? `Newest verified backup ${Math.floor(backupAgeMs / 60000)} min ago` : "No verified backup yet"}</Text>}
        <Button c={c} small text="Open Backups" onPress={() => setSettingsTab("backups")} /></View>}
    {settingsTab === "profiles" && <ProfilesPanel c={c} compact={compact} inset={inset} state={state ?? null} repositories={Array.isArray(repositoriesQuery.data) ? repositoriesQuery.data : []} busy={busy}
      savePool={entry => setProfile(entry).then(async () => { await queryClient.invalidateQueries({ queryKey: ["nucleus", "state"] }); await queryClient.invalidateQueries({ queryKey: ["nucleus", "profiles"] }); }).catch(e => { setError(errorText(e)); throw e; })}
      savePoolList={entries => act(() => setPool({ entries }))} saveAvailability={value => act(() => setAvailability(value))} />}
    {settingsTab === "capacity" && state && <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: inset, width: "100%", maxWidth: 780 }}>
      <DispatchLimits c={c} state={state} busy={busy} authority={capacityStateQuery.data} authorityError={capacityStateQuery.error}
        retryAuthority={() => void capacityStateQuery.refetch()} refreshBoard={() => stateQuery.refetch()}
        saveUsage={(level, until) => persist(() => setUsage({ level, until }))} saveDemandOffsets={value => persist(() => setDemandOffsets(value))}
        saveCapacity={value => persist(async () => { await setCapacity(value); await queryClient.refetchQueries({ queryKey: ["nucleus", "capacity-state"], exact: true }); })}
        saveProjectLimit={value => persist(() => setProjectLimit(value))} />
    </ScrollView>}
    {settingsTab === "projects" && <ProjectsSection c={c} compact={compact} inset={inset} query={projectsQuery}
      createProject={async input => {
        // Refresh even after a refusal so the next Create derives a free key.
        let writeError: unknown;
        try { await upsertProject(input); } catch (failure) { writeError = failure; }
        const refreshes = await Promise.allSettled([
          queryClient.refetchQueries({ queryKey: ["nucleus", "project-settings"], exact: true }),
          queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true }),
        ]);
        if (writeError !== undefined) throw writeError;
        const failedRefresh = refreshes.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failedRefresh) setError(`Project was created, but refresh failed: ${errorText(failedRefresh.reason)}`);
      }}
      edit={{
        saveProject: input => upsertProject(input), setPlanner: input => setProjectPlanner({ ...input, setBy: "operator" }),
        registerAgent: input => registerProjectAgent(input), unregisterAgent: input => unregisterProjectAgent(input),
        setSlots: input => setProjectLimit(input), setRepository: input => setRepository(input),
        park: input => parkProject(input), unpark: input => unparkProject(input),
        repositoryBlockers: input => repositoryBlockers(input), removeRepository: input => removeProjectRepository(input),
        mergeCheck: input => mergeCheck(input), merge: input => mergeProject(input),
        removal: { previewRpc: previewRemoval, removeRpc: removeProject, cancelRpc: cancelTasks, cancellationRpc: cancellationReceipt, resetRpc: resetRemoval },
        refresh: () => Promise.all([
          queryClient.refetchQueries({ queryKey: ["nucleus", "project-settings"], exact: true }),
          queryClient.refetchQueries({ queryKey: ["nucleus", "state"], exact: true }),
        ]),
        candidates: { data: candidatesQuery.data, error: candidatesQuery.error, isPending: candidatesQuery.isPending },
      }} />}
    {settingsTab === "backups" && <BackupsPanel c={c} inset={inset} list={backupsQuery.data} loading={backupsQuery.isPending} loadError={backupsQuery.error} health={state?.backup}
      backUp={() => act(async () => { await makeBackup({}); await backupsQuery.refetch(); })} />}
    {settingsTab === "telemetry" && <SettingsTelemetry c={c} compact={compact} />}
    </View>
  </View></PopoverHost>;
}

/* ------------------------------------------------------------------------- */
/* Spec 052 / nucleus#934: one Profiles page for stored records and dispatch  */
/* ------------------------------------------------------------------------- */
