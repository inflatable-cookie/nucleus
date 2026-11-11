import { errorText, errorText as failureText } from "./error-text";
import { activeGroupLimit, PROFILE_CAPABILITY_LEVELS, removePoolEntry, stalePoolEntries } from '../shared/pool';
import { createAutoSave, type AutoSave } from "../shared/autosave";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc, type BoardSurfaceProps } from "./shell";
import { ActionButton, Button, StatusGlyph, Disclosure, DropdownSelect, Field, FieldCaption, LabelHelp, NumberStepper, Section, StopSlider, TabRow, controlText, muted, row, type Colors } from "./controls";
import { control, space } from "./design";
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
import { hostModelFor, hostProviderFor, normaliseProvider, profileAvailability, providerMapSuggestions, type NucleusProfile, type ProviderMap, type ProviderMapSuggestion } from "../shared/profiles";
import type { HostCatalog, HostFeature, HostModel, HostProvider, StoredHostCatalog } from "../shared/host";
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
  return <PopoverHost style={{ width: "100%" }}><View accessibilityLabel="Nucleus settings" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, width: "100%", minWidth: 0, minHeight: 0, backgroundColor: c.surface0, paddingTop: inset, gap: 14 }}>
    {(error || stateQuery.error || state?.error) && <View style={{ ...row, flexWrap: "nowrap" }}><Text accessibilityRole="alert" style={{ color: c.statusDanger, flex: 1 }}>{error || String(stateQuery.error || state?.error)}</Text>
      {error && <ActionButton c={c} action="close" label="Dismiss error" onPress={() => setError("")} />}</View>}
    {/* Five short tabs fit one line at Paseo's 640–700 point settings column (nucleus#963). */}
    <TabRow c={c} label="Settings sections" nowrap tabs={settingsViews.map(view => ({ id: view.id, text: view.short, label: view.label }))} value={settingsTab} onChange={setSettingsTab} />
    <View style={{flex:1, minWidth:0, minHeight:0, gap:12}}>
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
      createProject={input => persist(async () => {
        // A refused create (a key taken since the list loaded) still refreshes, so the next Create derives a free key.
        try { await upsertProject(input); }
        finally { await queryClient.refetchQueries({ queryKey: ["nucleus", "project-settings"], exact: true }).catch(() => undefined); }
      })}
      edit={{
        saveProject: input => upsertProject(input), setPlanner: input => setProjectPlanner({ ...input, setBy: "operator" }),
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

const COST_LEVELS = ["very_low", "low", "medium", "high", "very_high"] as const;
const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1).replaceAll("_", " ");
/** Below this editor width (a phone) paired fields stack; Paseo's settings column keeps them side by side. */
const PAIRED_MIN_WIDTH = 460;
const HOST_DEFAULT = { value: "", label: "Host default" };
const PLAIN_KEYS: Record<string, string> = { xhigh: "Extra high", xlow: "Extra low", max: "Maximum", min: "Minimum" };
/**
 * A host option in plain words: the host's display label when it reads as words,
 * else its raw key spelled out ("xhigh" reads "Extra high", "full_access" "Full access").
 */
export function plainWords(label: string | undefined, id: string): string {
  const text = (label ?? "").trim() || id;
  // Words already: a space, or a leading capital ("Full Access"). A camelCase key is still a key.
  if (/\s/.test(text) || /^[A-Z]/.test(text)) return text;
  const known = PLAIN_KEYS[text.toLowerCase()];
  if (known) return known;
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type ProfileDraft = {
  name: string; provider: string; model: string;
  modeId: string | null; thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
};

const emptyProfileDraft = (): ProfileDraft => ({ name: "", provider: "", model: "", modeId: null, thinkingOptionId: null, featureValues: {} });
const profileDraft = (profile: Pick<NucleusProfile, "name" | "provider" | "model" | "modeId" | "thinkingOptionId" | "featureValues">): ProfileDraft => ({
  name: profile.name, provider: profile.provider, model: profile.model,
  modeId: profile.modeId ?? null, thinkingOptionId: profile.thinkingOptionId ?? null,
  featureValues: profile.featureValues ?? {},
});


/** The host provider a stored profile names, through the provider map, or null when this host lacks it. */
function namedProvider(provider: string, catalog: HostCatalog | undefined, providerMap: ProviderMap | undefined) {
  return catalog && providerMap && provider ? hostProviderFor(provider, catalog, providerMap) : null;
}

/**
 * A short plain reason for an unavailable provider, for the dropdown label.
 * Sign-in and disabled map to fixed phrases; a raw host error is never stacked
 * under the field (Tom, 2026-11-08).
 */
function providerShortReason(provider: HostProvider): string {
  const text = provider.problem.trim();
  const lower = text.toLowerCase();
  if (/\b(sign[- ]?in|sign[- ]?on|unauthenticated|auth(?:entication)?|log[- ]?in)\b/.test(lower)) return "needs sign-in";
  if (/\bdisabled\b/.test(lower)) return "unavailable";
  const first = text.split(/[.!\n]/)[0]?.trim() ?? "";
  if (!first) return "unavailable";
  return first.length > 48 ? "unavailable" : first;
}

function providerOptionLabel(provider: HostProvider): string {
  const label = provider.label || provider.key;
  return provider.available ? label : `${label} · ${providerShortReason(provider)}`;
}

/** Project display name for a repository path: the project name, else its origin, never the path. */
function projectNameForPath(path: string, projects: readonly Project[], repositories: readonly RepositorySettings[]): string {
  const project = projects.find(candidate => candidate.repositories.some(repo => repo.path === path));
  if (project) return project.name;
  const row = repositories.find(candidate => candidate.repository.path === path);
  if (row?.repository.origin) return row.repository.origin;
  return "this project";
}

function featureFingerprint(model: HostModel | null): string {
  if (!model) return "";
  return JSON.stringify(model.features.map(feature => ({
    id: feature.id, type: feature.type, value: feature.value,
    options: feature.type === "select" ? feature.options.map(option => option.id) : [],
  })));
}

function defaultPoolEntry(profile: Pick<Profile, "id" | "provider" | "model">): PoolEntry {
  return { profileId: profile.id, enabled: false, roles: ["worker"], group: profile.provider === "omp" ? `omp-${profile.model.split("/")[0]}` : profile.provider, weight: 1, scopes: ["general"] };
}

/**
 * A row's status, only when something needs a look: unavailable, else a paused
 * subscription group. By request and its status are retired (Tom, 2026-11-09).
 */
function profileRowStatus(profile: Pick<Profile, "available">, entry: PoolEntry, state: UiQueueState): { problem: string } {
  return { problem: !profile.available ? "Unavailable" : activeGroupLimit(state.availability, entry.group) ? "Subscription paused" : "" };
}

function modelWords(profile: Pick<Profile, "provider" | "model">, catalog: HostCatalog | undefined, providerMap: ProviderMap | undefined): string {
  const provider = namedProvider(profile.provider, catalog, providerMap);
  const model = provider ? hostModelFor(profile.model, provider) : null;
  return model?.label || profile.model || "no model";
}

type CatalogRead = { cwd: string; catalog: HostCatalog };

/** How long ago the stored catalog was read from the host, for the Refresh tooltip. */
export function catalogAge(readAt: string | undefined, nowMs = Date.now()): string {
  const at = readAt ? Date.parse(readAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "read just now";
  if (minutes < 60) return `read ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `read ${hours} h ago`;
  return `read ${Math.floor(hours / 24)} d ago`;
}

function identityCreateInput(draft: ProfileDraft) {
  return {
    name: draft.name.trim(), provider: draft.provider, model: draft.model,
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.thinkingOptionId ? { thinkingOptionId: draft.thinkingOptionId } : {}),
    ...(Object.keys(draft.featureValues).length ? { featureValues: draft.featureValues } : {}),
  };
}

function identityValid(draft: ProfileDraft) {
  return draft.name.trim().length > 0 && draft.provider.length > 0 && draft.model.length > 0;
}

/** One live profile row: name, labelled attention icons when needed, on/off and Edit. */
function ProfileRow({ c, profile, board, catalog, catalogs, providerMap, directory, projects, repositories, state, busy, editing, poolSave, actionStatus, onEdit, onCreated, onDuplicate, onRemove, onChooseDirectory }: {
  c: Colors; profile: NucleusProfile | Profile; board: Profile | null; catalog: HostCatalog | undefined;
  catalogs: CatalogRead[]; providerMap: ProviderMap | undefined; directory: string | null; projects: readonly Project[];
  repositories: readonly RepositorySettings[]; state: UiQueueState | null; busy: boolean; editing: boolean;
  poolSave: (entry: PoolEntry) => Promise<void>; actionStatus: string; onEdit: () => void; onCreated: (profile: NucleusProfile) => void;
  onDuplicate: () => void; onRemove: () => Promise<void>; onChooseDirectory: (cwd: string) => void;
}) {
  const original: PoolEntry = state?.pool.find(entry => entry.profileId === profile.id) ?? defaultPoolEntry(profile);
  const [entry, setEntry] = useState(original), [saveStatus, setSaveStatus] = useState("");
  const mounted = useRef(true), saveRef = useRef(poolSave), entryRef = useRef(entry); saveRef.current = poolSave;
  const saver = useRef<AutoSave<PoolEntry> | null>(null);
  if (!saver.current) saver.current = createAutoSave(value => saveRef.current(value), status => { if (mounted.current) setSaveStatus(entryRef.current.group.trim() ? status : "Subscription is required"); });
  const originalJson = JSON.stringify(original);
  useEffect(() => { if (!saver.current!.busy && !saveStatus.startsWith("Not saved") && saveStatus !== "Subscription is required") { setEntry(original); entryRef.current = original; } }, [originalJson]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void saver.current!.flush(); }; }, []);
  function change(patch: Partial<PoolEntry>, delay = 0) {
    const next = { ...entryRef.current, ...patch }; entryRef.current = next; setEntry(next);
    if (!next.group.trim()) { saver.current!.cancelPending(); setSaveStatus("Subscription is required"); return; }
    saver.current!.enqueue(next, delay);
  }
  const availability = board ?? (catalog && providerMap ? { ...profile, ...profileAvailability(profile, catalog, providerMap) } : { ...profile, available: true, problem: "", supportedThinking: [] as string[] });
  const status = state ? profileRowStatus(availability, entry, state) : { problem: "" };
  return <View style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 9, gap: 8 }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontWeight: "600", fontSize: 14 }}>{profile.name}</Text>
      {status.problem ? <StatusGlyph c={c} icon="TriangleAlert" color={c.statusWarning} text={status.problem} label={`${profile.name}: ${status.problem}`} /> : null}
      <Button matchField c={c} text={entry.enabled ? "On" : "Off"} selected={entry.enabled} disabled={busy || !state} label={`${entry.enabled ? "Disable" : "Enable"} ${profile.name}`} onPress={() => change({ enabled: !entry.enabled })} />
      <ActionButton c={c} action={editing ? "close" : "edit"} label={`${editing ? "Close" : "Edit"} ${profile.name}`} onPress={() => { void saver.current!.flush(); onEdit(); }} />
    </View>
    {editing && <ProfileEditor c={c} catalog={catalog} catalogs={catalogs} providerMap={providerMap} directory={directory}
      projects={projects} repositories={repositories} initial={profile} entry={state ? entry : null} state={state}
      busy={busy} poolSaveStatus={saveStatus} actionStatus={actionStatus} onChangePool={state ? change : undefined} onFlushPool={() => void saver.current!.flush()}
      onCreated={onCreated} onDuplicate={onDuplicate} onRemove={onRemove} onChooseDirectory={onChooseDirectory} />}
  </View>;
}

function quietSaveStatus(status: string) {
  if (status === "Saved" || status.startsWith("Not saved") || status === "Subscription is required" || status === "A name, a provider and a model are needed.") return status;
  return "";
}

/**
 * Create or edit one stored profile from what the host reports. Provider, model,
 * mode and thinking are dropdowns; a list that is only Host default is plain
 * text. Changes save on entry (Tom, 2026-11-08): text after a short pause,
 * choices at once. There is no Save or Cancel. Notes stay stored and unshown.
 */
function ProfileEditor({ c, catalog, catalogs, providerMap, directory, projects, repositories, initial, entry, state, busy, poolSaveStatus, actionStatus, onChangePool, onFlushPool, onCreated, onDuplicate, onRemove, onChooseDirectory, onClose }: {
  c: Colors; catalog: HostCatalog | undefined; catalogs: CatalogRead[]; providerMap: ProviderMap | undefined;
  directory: string | null; projects: readonly Project[]; repositories: readonly RepositorySettings[];
  initial: (NucleusProfile | Profile) | null; entry: PoolEntry | null; state: UiQueueState | null;
  busy: boolean; poolSaveStatus: string; actionStatus?: string; onChangePool?: (patch: Partial<PoolEntry>, delay?: number) => void; onFlushPool?: () => void;
  onCreated?: (profile: NucleusProfile) => void; onDuplicate?: () => void; onRemove?: () => Promise<void>;
  onChooseDirectory: (cwd: string) => void; onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const createProfile = useRpc(api.createNucleusProfile), updateProfile = useRpc(api.updateNucleusProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() => initial ? profileDraft(initial) : emptyProfileDraft());
  const [identityStatus, setIdentityStatus] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [projectChoice, setProjectChoice] = useState(false);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  const idRef = useRef(initial && "id" in initial ? initial.id : null);
  const createRef = useRef(createProfile); createRef.current = createProfile;
  const updateRef = useRef(updateProfile); updateRef.current = updateProfile;
  const createdRef = useRef(onCreated); createdRef.current = onCreated;
  const identitySaver = useRef<AutoSave<ProfileDraft> | null>(null);
  if (!identitySaver.current) identitySaver.current = createAutoSave(async value => {
    if (idRef.current) {
      await updateRef.current({
        id: idRef.current, name: value.name.trim(), provider: value.provider, model: value.model,
        modeId: value.modeId, thinkingOptionId: value.thinkingOptionId, featureValues: value.featureValues,
      });
    } else {
      const result = await createRef.current(identityCreateInput(value));
      idRef.current = result.profile.id;
      createdRef.current?.(result.profile);
    }
    await queryClient.invalidateQueries({ queryKey: ["nucleus", "profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["nucleus", "state"] });
  }, status => { if (mounted.current) setIdentityStatus(status); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void identitySaver.current!.flush(); }; }, []);
  function applyIdentity(patch: Partial<ProfileDraft>, delay = 0) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (!identityValid(next)) {
      identitySaver.current!.cancelPending();
      setIdentityStatus(next.name.trim() || next.provider || next.model ? "A name, a provider and a model are needed." : "");
      return;
    }
    identitySaver.current!.enqueue(next, delay);
  }
  const providers = catalog?.providers ?? [];
  const provider = namedProvider(draft.provider, catalog, providerMap);
  const model = provider && draft.model ? hostModelFor(draft.model, provider) : null;
  const availability = catalog && providerMap && draft.provider && draft.model
    ? profileAvailability({ provider: draft.provider, model: draft.model, ...(draft.thinkingOptionId ? { thinkingOptionId: draft.thinkingOptionId } : {}) }, catalog, providerMap)
    : null;
  const selectedHostKey = providers.find(candidate => normaliseProvider(providerMap ?? {}, candidate.key) === draft.provider)?.key ?? draft.provider;
  const providerOptions = [
    ...providers.map(candidate => ({ value: candidate.key, label: providerOptionLabel(candidate) })),
    ...(draft.provider && !providers.some(candidate => normaliseProvider(providerMap ?? {}, candidate.key) === draft.provider)
      ? [{ value: draft.provider, label: `${draft.provider} · unavailable` }] : []),
  ];
  const modelOptions = [
    ...(provider?.models ?? []).map(candidate => ({ value: candidate.id, label: candidate.label || candidate.id })),
    ...(draft.model && !(provider?.models ?? []).some(candidate => candidate.id === draft.model || candidate.aliases.includes(draft.model))
      ? [{ value: draft.model, label: draft.model }] : []),
  ];
  const chooseProvider = (key: string) => applyIdentity({ provider: normaliseProvider(providerMap ?? {}, key), model: "", modeId: null, thinkingOptionId: null, featureValues: {} });
  const chooseModel = (id: string) => {
    const next = provider?.models.find(candidate => candidate.id === id);
    applyIdentity({
      model: id, modeId: null, thinkingOptionId: next?.defaultThinkingOptionId ?? null,
      featureValues: Object.fromEntries((next?.features ?? []).map(feature => [feature.id, feature.value])),
    });
  };
  const featureValue = (feature: HostFeature) => Object.prototype.hasOwnProperty.call(draft.featureValues, feature.id) ? draft.featureValues[feature.id] : feature.value;
  const setFeature = (feature: HostFeature, value: unknown) => applyIdentity({ featureValues: { ...draft.featureValues, [feature.id]: value } });
  const differing = catalogs.length > 1 ? [...new Set(catalogs.map(read => {
    const host = namedProvider(draft.provider, read.catalog, providerMap);
    return featureFingerprint(host && draft.model ? hostModelFor(draft.model, host) : null);
  }))].length > 1 ? [...new Set(catalogs.map(read => projectNameForPath(read.cwd, projects, repositories)))] : [] : [];
  const identityQuiet = quietSaveStatus(identityStatus);
  const poolQuiet = quietSaveStatus(poolSaveStatus);
  const actionQuiet = quietSaveStatus(actionStatus ?? "");
  const saveStatus = actionQuiet.startsWith("Not saved") ? actionQuiet
    : identityQuiet.startsWith("Not saved") || identityQuiet === "A name, a provider and a model are needed." || !poolQuiet ? identityQuiet : poolQuiet;
  const failed = saveStatus.startsWith("Not saved") || saveStatus === "A name, a provider and a model are needed." || saveStatus === "Subscription is required";
  const [editorWidth, setEditorWidth] = useState(0);
  // Paired rows follow the editor's own measured width, not the screen's compact flag:
  // Paseo's settings column (about 640 points) is compact for the screen but fits two columns.
  const narrow = editorWidth > 0 && editorWidth < PAIRED_MIN_WIDTH;
  const half = { flex: 1, minWidth: narrow ? "100%" as const : 0 };
  const pair = { ...row, columnGap: 16, rowGap: 12 };
  const name = initial?.name ?? "profile";
  // Every model option the host offers, in a stable order: Mode, Thinking, then features.
  // They flow two to a row; an odd last one spans the row (Tom, 2026-11-08).
  const options: { key: string; node: React.ReactNode }[] = model ? [
    ...(model.modes.length > 0 ? [{ key: "mode", node: <DropdownSelect label="Mode" value={draft.modeId ?? ""} options={[HOST_DEFAULT, ...model.modes.map(mode => ({ value: mode.id, label: plainWords(mode.label, mode.id) }))]} onChange={value => applyIdentity({ modeId: value || null })} c={c} disabled={busy} /> }] : []),
    { key: "thinking", node: model.thinkingOptions.length
      ? <DropdownSelect label="Thinking" value={draft.thinkingOptionId ?? ""} options={[HOST_DEFAULT, ...model.thinkingOptions.map(option => ({ value: option.id, label: plainWords(option.label, option.id) }))]}
          onChange={value => applyIdentity({ thinkingOptionId: value || null })} c={c} disabled={busy} />
      : <View style={{ gap: space.xxs }}><FieldCaption c={c} text="Thinking" /><View style={{ minHeight: control.height, justifyContent: "center" }}><Text style={controlText(c)}>Host default</Text></View></View> },
    ...model.features.map(feature => ({ key: `feature:${feature.id}`, node: feature.type === "toggle"
      ? <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text={feature.label} />
          <View style={row}>
            <Button matchField c={c} text="On" label={`Feature ${feature.label} on`} selected={featureValue(feature) === true} disabled={busy} onPress={() => setFeature(feature, true)} />
            <Button matchField c={c} text="Off" label={`Feature ${feature.label} off`} selected={featureValue(feature) === false} disabled={busy} onPress={() => setFeature(feature, false)} />
          </View>
        </View>
      : <DropdownSelect label={feature.label} value={featureValue(feature) == null ? "" : String(featureValue(feature))}
          options={[HOST_DEFAULT, ...feature.options.map(option => ({ value: option.id, label: plainWords(option.label, option.id) }))]}
          onChange={value => setFeature(feature, value || null)} c={c} disabled={busy} /> })),
  ] : [];
  const optionRows = Array.from({ length: Math.ceil(options.length / 2) }, (_, i) => options.slice(i * 2, i * 2 + 2));
  /** A slider field's label row: the name and its (?), then the chosen value at the right. */
  const sliderLabel = (label: string, help: string, value: string | null | undefined) => <View style={{ ...row, flexWrap: "nowrap" }}>
    <View style={{ flex: 1, minWidth: 0 }}><FieldCaption c={c} text={label} help={help} /></View>
    <Text accessibilityLabel={`${label} value`} style={{ ...muted(c), fontSize: 12 }}>{value ? levelLabel(value) : "Unset"}</Text>
  </View>;
  return <View accessibilityLabel={`${initial?.name ?? "New profile"} editor`} onLayout={event => setEditorWidth(event.nativeEvent.layout.width)} style={{ gap: 12, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    {/* Name shares its row with the card actions (Tom, 2026-11-08); the placeholder and accessible label carry "Name". */}
    <View accessibilityLabel="Profile name row" style={{ ...row, flexWrap: "nowrap" }}>
      <View style={{ flex: 1, minWidth: 0 }}><Field hideLabel c={c} label="Name" value={draft.name} onChange={next => applyIdentity({ name: next }, 600)} onBlur={() => void identitySaver.current!.flush()} placeholder="Name" /></View>
      {saveStatus && !failed ? <Text accessibilityLiveRegion="polite" accessibilityLabel="Profile save status" style={muted(c)}>{saveStatus}</Text> : null}
      {onClose && <ActionButton c={c} action="close" label="Close new profile" onPress={onClose} />}
      {initial && onDuplicate && <ActionButton c={c} action="duplicate" label={`Duplicate ${initial.name}`} onPress={onDuplicate} disabled={busy} />}
      {initial && onRemove && !confirmingRemove && <ActionButton c={c} action="remove" label={`Remove ${initial.name}`} onPress={() => setConfirmingRemove(true)} disabled={busy} />}
    </View>
    {/* A failure needs room to read, so it takes its own line under the Name row. */}
    {saveStatus && failed ? <Text accessibilityLiveRegion="polite" accessibilityLabel="Profile save status" style={{ ...muted(c), color: c.statusWarning, flexShrink: 1 }}>{saveStatus}</Text> : null}
    {/* Subscription and Weight take half the row each; on a phone each takes the full row. */}
    {entry && onChangePool && state && <View accessibilityLabel="Profile dispatch row" style={{ ...pair, alignItems: "flex-end" }}>
      <View style={half}><Field c={c} label="Subscription" invalid={saveStatus === "Subscription is required"} value={entry.group} onChange={group => onChangePool({ group }, 600)} onBlur={onFlushPool} /></View>
      <View style={{ ...half, gap: space.xxs }}>
          <FieldCaption c={c} text="Weight" help={`Weight 2 receives roughly twice the assignments of weight 1.${initial ? ` Recent assignments: ${state.recentAssignments[`profile:${initial.id}`] ?? 0}; total assignments: ${state.assignments[`profile:${initial.id}`] ?? 0}.` : ""}`} />
          <NumberStepper c={c} a11yLabel={`Weight for ${name}`} value={entry.weight} min={1} max={10} disabled={busy}
            decreaseLabel={`Decrease weight for ${name}`} increaseLabel={`Increase weight for ${name}`}
            onChange={weight => onChangePool({ weight })} onCommit={onFlushPool} style={{ minHeight: control.height, justifyContent: "center" }} />
      </View>
    </View>}
    <View style={{ ...pair, alignItems: "stretch" }}><View style={half}><DropdownSelect label="Provider" value={selectedHostKey} options={providerOptions} onChange={chooseProvider} c={c} disabled={busy} placeholder="Choose a provider" emptyText={catalog ? "This host reports no providers." : "Reading the host catalog…"} /></View>
      <View style={half}><DropdownSelect label="Model" value={draft.model} options={modelOptions} onChange={chooseModel} c={c} disabled={busy || !draft.provider} placeholder="Choose a model" emptyText={provider ? "This provider reports no models." : "Choose a provider first."} /></View></View>
    {optionRows.map(cells => <View key={cells.map(cell => cell.key).join("|")} accessibilityLabel="Model options row" style={{ ...pair, alignItems: "flex-end" }}>
      {cells.map(cell => <View key={cell.key} style={half}>{cell.node}</View>)}
    </View>)}
    {differing.length > 0 && <View style={{ gap: 6 }}>
      <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12, flexShrink: 1 }}>Feature values differ for {differing.length === 2 ? differing.join(" and ") : differing.join(", ")}.</Text>
      <Disclosure c={c} label="Choose which project to use" expanded={projectChoice} onToggle={() => setProjectChoice(open => !open)} />
      {projectChoice && <DropdownSelect label="Project" value={directory ?? ""}
        options={catalogs.map(read => ({ value: read.cwd, label: projectNameForPath(read.cwd, projects, repositories) }))}
        onChange={onChooseDirectory} c={c} />}
    </View>}
    {availability && !availability.available && <Text accessibilityLabel="Profile availability preview" style={{ color: c.statusWarning, fontSize: 12 }}>{availability.problem}</Text>}
    {entry && onChangePool && state && <View style={{ ...pair, alignItems: "flex-start" }}><View style={{ ...half, gap: 6 }}>
        {sliderLabel("Cost", "Each cost step down doubles this profile's share. Above the usage level's ceiling it needs a request. Unset ranks as medium and is never cost-gated.", entry.cost)}
        <StopSlider captions={false} c={c} a11yLabel="Cost" stops={COST_LEVELS} value={entry.cost ?? null} labelFor={levelLabel} stopLabel={cost => `Cost ${cost.replaceAll("_", " ")}`} onChange={cost => onChangePool({ cost: entry.cost === cost ? null : cost })} />
      </View><View style={{ ...half, gap: 6 }}>
        {sliderLabel("Capability", "Each run needs the task's complexity moved by its role and the usage level. Selection rotates among profiles at or above that. Frontier runs only on request below Maximum. Unset counts as medium.", entry.capability)}
        <StopSlider captions={false} c={c} a11yLabel="Capability" stops={PROFILE_CAPABILITY_LEVELS} unsetStop="medium" value={entry.capability ?? null} labelFor={levelLabel} stopLabel={level => `Capability ${level.replaceAll("_", " ")}`} onChange={level => onChangePool({ capability: entry.capability === level ? null : level })} />
      </View></View>}
    {initial && confirmingRemove && onRemove && <View style={{ ...row, gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
        <Text style={{ color: c.statusWarning, fontSize: 12, flexShrink: 1 }}>Remove {initial.name}?</Text>
        <Button small danger c={c} text="Remove profile" label={`Confirm removing ${initial.name}`} disabled={busy} onPress={() => void onRemove()} />
        <Button small c={c} text="Keep" label={`Keep ${initial.name}`} onPress={() => setConfirmingRemove(false)} />
      </View>}
  </View>;
}

/**
 * One Profiles page: stored records and their dispatch settings. Add, duplicate
 * and remove live here. Feature values come from one automatically chosen
 * directory. Nothing is stored differently; only how it is shown changes.
 */
function ProfilesPanel({ c, compact, inset, state, repositories, busy, savePool, savePoolList, saveAvailability }: {
  c: Colors; compact: boolean; inset: number; state: UiQueueState | null; repositories: RepositorySettings[];
  busy: boolean; savePool: (entry: PoolEntry) => Promise<void>; savePoolList: (entries: PoolEntry[]) => Promise<boolean>;
  saveAvailability: (value: UiQueueState["availability"][number]) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const fetchProfiles = useRpc(api.listNucleusProfiles), fetchProviderMap = useRpc(api.readProviderMap), fetchCatalog = useRpc(api.readHostCatalog);
  const createProfile = useRpc(api.createNucleusProfile), removeProfile = useRpc(api.removeNucleusProfile), saveProviderMap = useRpc(api.writeProviderMap);
  const directories = [...new Set(repositories.map(row => row.repository.path).filter(path => path.length > 0))];
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<string | "new" | null>(null);
  const [mapStatus, setMapStatus] = useState("");
  const [created, setCreated] = useState<NucleusProfile | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const editorKey = editor === "new" ? "new" : editor ?? "";
  const directory = lastUsed[editorKey] && directories.includes(lastUsed[editorKey]!) ? lastUsed[editorKey]! : directories[0] ?? null;
  const profilesQuery = useQuery({ queryKey: ["nucleus", "profiles"], queryFn: () => fetchProfiles({}) });
  const providerMapQuery = useQuery({ queryKey: ["nucleus", "provider-map"], queryFn: () => fetchProviderMap({}) });
  const catalogQuery = useQuery({ queryKey: ["nucleus", "host-catalog", directory ?? ""], queryFn: () => fetchCatalog(directory ? { cwd: directory } : {}), staleTime: 30_000 });
  const catalogsQuery = useQuery({
    queryKey: ["nucleus", "host-catalogs", directories.join("|")],
    queryFn: () => Promise.all(directories.map(async cwd => ({ cwd, catalog: await fetchCatalog({ cwd }) }))),
    enabled: editor !== null && directories.length > 1, staleTime: 30_000,
  });
  const catalog = catalogQuery.data;
  const catalogs = catalogsQuery.data ?? (directory && catalog ? [{ cwd: directory, catalog }] : []);
  const providerMap = providerMapQuery.data?.providers;
  const stored = profilesQuery.data?.profiles ?? [];
  const boardProfiles = state?.profiles ?? [];
  const live: { id: string; name: string; stored: NucleusProfile | null; board: Profile | null }[] = (() => {
    const map = new Map<string, { id: string; name: string; stored: NucleusProfile | null; board: Profile | null }>();
    for (const profile of boardProfiles) map.set(profile.id, { id: profile.id, name: profile.name, stored: null, board: profile });
    for (const profile of stored) {
      const current = map.get(profile.id);
      if (current) { current.stored = profile; current.name = profile.name; }
      else map.set(profile.id, { id: profile.id, name: profile.name, stored: profile, board: null });
    }
    if (created && !map.has(created.id)) map.set(created.id, { id: created.id, name: created.name, stored: created, board: null });
    return [...map.values()];
  })();
  useEffect(() => {
    if (created && profilesQuery.data?.profiles.some(profile => profile.id === created.id)) setCreated(null);
  }, [created, profilesQuery.data]);
  const panelBusy = busy || Boolean(removing) || mapStatus === "Saving…";
  /**
   * Refresh reads the host live for every directory the page reads and replaces
   * Nucleus's stored catalog (nucleus#970). The stored lists stay usable while it
   * runs; a directory whose read fails keeps its stored catalog, and the page
   * shows the first reason once.
   */
  async function refreshCatalog() {
    setRefreshing(true);
    setRefreshError("");
    try {
      const cwds: (string | null)[] = directories.length ? directories : [null];
      const reads = await Promise.allSettled(cwds.map(async cwd => ({ cwd, catalog: await fetchCatalog(cwd ? { cwd, refresh: true } : { refresh: true }) })));
      for (const read of reads) if (read.status === "fulfilled") queryClient.setQueryData(["nucleus", "host-catalog", read.value.cwd ?? ""], read.value.catalog);
      const failed = reads.find(read => read.status === "rejected");
      if (failed) setRefreshError(failureText(failed.reason));
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "host-catalogs"] });
    } finally { setRefreshing(false); }
  }
  const age = catalogAge(catalogQuery.data?.readAt);
  const refreshText = refreshing ? "Refreshing providers and models…" : age ? `Refresh providers and models · ${age}` : "Refresh providers and models";
  const refreshProfiles = () => queryClient.invalidateQueries({ queryKey: ["nucleus", "profiles"] });
  const chooseDirectory = (cwd: string) => setLastUsed(current => ({ ...current, [editorKey]: cwd }));
  async function duplicate(profile: NucleusProfile | Profile) {
    setActionStatus("");
    try {
      await createProfile({
        name: `${profile.name} copy`, provider: profile.provider, model: profile.model,
        ...("modeId" in profile && profile.modeId ? { modeId: profile.modeId } : {}),
        ...("thinkingOptionId" in profile && profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
        ...("featureValues" in profile && profile.featureValues && Object.keys(profile.featureValues).length ? { featureValues: profile.featureValues } : {}),
        ...("notes" in profile && profile.notes ? { notes: profile.notes } : {}),
      });
      await refreshProfiles();
    } catch (error) { setActionStatus(`Not saved: ${failureText(error)}`); }
  }
  async function remove(id: string) {
    setRemoving(id);
    setActionStatus("");
    try {
      await removeProfile({ id });
      setCreated(current => current?.id === id ? null : current);
      if (editor === id) setEditor(null);
      if (state?.pool.some(entry => entry.profileId === id)) await savePoolList(removePoolEntry(state.pool, id));
      await refreshProfiles();
    } catch (error) { setActionStatus(`Not saved: ${failureText(error)}`); }
    finally { setRemoving(null); }
  }
  async function writeProviderMap(next: ProviderMap) {
    setMapStatus("Saving…");
    try {
      await saveProviderMap({ providers: next });
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "provider-map"] });
      setMapStatus("Saved");
      return true;
    } catch (error) { setMapStatus(`Not saved: ${failureText(error)}`); return false; }
  }
  const stale = state ? stalePoolEntries(state.pool, state.connected ? state.profiles : []) : [];
  // One catalog per host the page can read: the host.catalog read serves the one connected host.
  const mapHosts = catalog ? [{ id: state?.hostId ?? "host", catalog }] : [];
  const mapProfiles = live.map(item => item.stored ?? item.board!);
  const mapShown = providerMapShown(mapHosts, mapProfiles, providerMap);
  const groups = state ? [...new Set(state.pool.map(entry => entry.group))] : [];
  // Profile and stale rows draw their own divider; a trailing loading or empty line does not.
  const profilesEndInRow = live.length > 0 || (stale.length > 0 && editor === "new" && !profilesQuery.isPending);
  return <ScrollView accessibilityLabel="Profiles page" style={{ flex: 1, minHeight: 0, width: compact ? "auto" : "100%", maxWidth: "100%" }} contentContainerStyle={{ paddingBottom: inset, width: "100%", maxWidth: 780 }}>
    {refreshError && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12 }}>Refresh failed: {refreshError}. The stored providers and models stay.</Text>}
    {catalogQuery.error && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12 }}>The host catalog could not be read: {failureText(catalogQuery.error)}</Text>}
    {profilesQuery.error && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12 }}>Could not read profiles: {failureText(profilesQuery.error)}</Text>}
    {providerMapQuery.error && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: 12 }}>Could not read the provider map: {failureText(providerMapQuery.error)}</Text>}
    <Section c={c} title="Profiles" label="Stored profiles" status={quietSaveStatus(actionStatus) || null} endsInRow={profilesEndInRow}
      description="A profile is a provider and model this host can run, and how Nucleus uses it for dispatch. Cost and capability sit in the editor."
      action={<View style={{ ...row, flexWrap: "nowrap" }}>
        <ActionButton c={c} action="refresh" tip={refreshText} label="Refresh providers and models" busy={refreshing} onPress={() => void refreshCatalog()} />
        <ActionButton c={c} action="add" label="Add profile" disabled={panelBusy || editor === "new"} onPress={() => setEditor("new")} />
      </View>}>
      {editor === "new" && <ProfileEditor key="new" c={c} catalog={catalog} catalogs={catalogs} providerMap={providerMap} directory={directory}
        projects={state?.projects ?? []} repositories={repositories} initial={null} entry={null} state={state}
        busy={panelBusy} poolSaveStatus="" onCreated={profile => { setCreated(profile); setEditor(profile.id); }} onChooseDirectory={chooseDirectory}
        onClose={() => setEditor(null)} />}
      {live.map(item => <ProfileRow key={item.id} c={c} profile={item.stored ?? item.board!} board={item.board} catalog={catalog}
        catalogs={catalogs} providerMap={providerMap} directory={directory} projects={state?.projects ?? []} repositories={repositories}
        state={state} busy={panelBusy} editing={editor === item.id} poolSave={savePool}
        onEdit={() => setEditor(editor === item.id ? null : item.id)} onCreated={profile => { setCreated(profile); setEditor(profile.id); }}
        onDuplicate={() => void duplicate(item.stored ?? item.board!)} onRemove={() => remove(item.id)} onChooseDirectory={chooseDirectory}
        actionStatus={actionStatus} />)}
      {stale.map(entry => <StalePoolEntry key={entry.profileId} c={c} entry={entry} busy={panelBusy} onRemove={() => void savePoolList(removePoolEntry(state!.pool, entry.profileId))} />)}
      {profilesQuery.isPending && !live.length && <Text style={muted(c)}>Reading profiles…</Text>}
      {!live.length && !profilesQuery.isPending && editor !== "new" && <Text style={muted(c)}>No profiles yet. Add one from what this host can run.</Text>}
    </Section>
    <View>
      <Section c={c} title="Subscriptions" label="Subscriptions" last={!mapShown} endsInRow={Boolean(state && groups.length)}
        description="Profiles that share a provider subscription form one group. An unavailable group leaves selection until its retry time or a reset.">
        {!state && <Text style={muted(c)}>Reading subscriptions…</Text>}
        {state && !groups.length && <Text style={muted(c)}>None yet. Add a profile first.</Text>}
        {state && groups.map(group => <Availability key={`${group}-${JSON.stringify(state.availability.find(a => a.group === group))}`} c={c} group={group} state={state} busy={busy} save={saveAvailability} />)}
      </Section>
    </View>
    <ProviderMapSection c={c} hosts={mapHosts} profiles={mapProfiles} providerMap={providerMap} busy={panelBusy}
      status={quietSaveStatus(mapStatus) || null} onSave={next => writeProviderMap(next)} />
  </ScrollView>;
}

/**
 * The provider map shows only where it can help or already holds an entry
 * (Tom, 2026-11-08): a second host offers a profile's model under another
 * provider key, or a stored entry needs editing. Otherwise, including while the
 * map is still being read, there is no section. `hosts` carries one catalog per
 * host the page can read; today that is the one Paseo host.
 */
export function ProviderMapSection({ c, hosts, profiles, providerMap, busy, status, onSave }: {
  c: Colors; hosts: readonly { id: string; catalog: HostCatalog }[]; profiles: readonly Pick<NucleusProfile, "name" | "provider" | "model">[];
  providerMap: ProviderMap | undefined; busy: boolean; status: string | null; onSave: (next: ProviderMap) => Promise<boolean>;
}) {
  if (!providerMap || !providerMapShown(hosts, profiles, providerMap)) return null;
  const entries = Object.entries(providerMap);
  const suggestion = providerMapSuggestions(hosts, profiles, providerMap)[0] ?? null;
  return <Section c={c} title="Provider map" label="Provider map" status={status} last
    description="A stored profile names a normalised provider key, so the same profile works on a host that spells a provider differently. Identity is the default: a host key with no entry maps to itself.">
    <ProviderMapEditor key={suggestion ? `${suggestion.hostId}:${suggestion.hostKey}` : "manual"} c={c} entries={entries} providerMap={providerMap}
      suggestion={suggestion} placeholder={hosts[0]?.catalog.providers[0]?.key ?? "openai-codex"} busy={busy} onSave={onSave} />
  </Section>;
}

function providerMapShown(hosts: readonly { id: string; catalog: HostCatalog }[], profiles: readonly Pick<NucleusProfile, "name" | "provider" | "model">[], providerMap: ProviderMap | undefined) {
  return Boolean(providerMap && (Object.keys(providerMap).length || providerMapSuggestions(hosts, profiles, providerMap).length));
}

/** The small provider-map editor: host provider key → the normalised key a profile names. */
function ProviderMapEditor({ c, entries, providerMap, suggestion, placeholder, busy, onSave }: {
  c: Colors; entries: [string, string][]; providerMap: ProviderMap; suggestion: ProviderMapSuggestion | null; placeholder: string;
  busy: boolean; onSave: (next: ProviderMap) => Promise<boolean>;
}) {
  const [hostKey, setHostKey] = useState(suggestion?.hostKey ?? ""), [normalised, setNormalised] = useState(suggestion?.normalised ?? "");
  const valid = hostKey.trim().length > 0 && normalised.trim().length > 0;
  return <View style={{ gap: 10 }}>
    {entries.map(([key, value]) => <View key={key} style={{ ...row, flexWrap: "nowrap" }}>
      <Text style={{ color: c.foreground, flex: 1, minWidth: 0, fontSize: 13 }}>{key} → {value}</Text>
      <ActionButton c={c} action="remove" label={`Remove provider map entry ${key}`} disabled={busy}
        onPress={() => onSave(Object.fromEntries(entries.filter(([candidate]) => candidate !== key)))} />
    </View>)}
    {suggestion && <Text accessibilityLabel="Provider map suggestion" style={{ ...muted(c), fontSize: 12 }}>
      Mapping {suggestion.hostKey} to {suggestion.normalised} makes {suggestion.profileName} available on {suggestion.hostId}.
    </Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
      <View style={{ flexGrow: 1, flexBasis: 180, minWidth: 0 }}><Field c={c} label="Host provider key" value={hostKey} onChange={setHostKey} placeholder={placeholder} /></View>
      <View style={{ flexGrow: 1, flexBasis: 180, minWidth: 0 }}><Field c={c} label="Normalised key" value={normalised} onChange={setNormalised} placeholder="openai" /></View>
      <ActionButton c={c} action="add" label="Add provider map entry" disabled={busy || !valid}
        onPress={() => void onSave({ ...providerMap, [hostKey.trim()]: normalised.trim() }).then(saved => { if (saved) { setHostKey(""); setNormalised(""); } })} />
    </View>
  </View>;
}

function StalePoolEntry({ c, entry, busy, onRemove }: { c: Colors; entry: PoolEntry; busy: boolean; onRemove: () => void }) {
  return <View style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 9, gap: 8 }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontWeight: "600", fontSize: 14 }}>{entry.profileId}</Text>
      <ActionButton c={c} action="remove" label={`Remove ${entry.profileId}`} disabled={busy} onPress={onRemove} />
    </View>
    <Text style={{ color: c.statusWarning, fontSize: 12 }}>This profile is gone</Text>
  </View>;
}

/**
 * One subscription group. Its row names the state only; the counts, the reason and the
 * pause sit in the opened editor, with the pause at its bottom.
 */
function Availability({ c, group, state, busy, save }: { c: Colors; group: string; state: UiQueueState; busy: boolean; save: (v: UiQueueState["availability"][number]) => Promise<unknown> }) {
  const current = state.availability.find(a => a.group === group);
  const [editing, setEditing] = useState(false), [reason, setReason] = useState(current?.reason ?? ""), [retryAt, setRetryAt] = useState(current?.retryAt ?? "");
  const paused = Boolean(activeGroupLimit(state.availability, group));
  return <View style={{ gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={row}><Text style={{ color: c.foreground, fontWeight: "600", flex: 1 }}>{group}</Text>
      <Text style={{ color: paused ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{paused ? current?.retryAt ? `Unavailable until ${new Date(current.retryAt).toLocaleString()}` : "Unavailable" : "Available"}</Text>
      {paused && <Button small c={c} text={`Reset ${group}`} disabled={busy} onPress={() => void save({ group, unavailable: false, reason: "Reset by operator", retryAt: null })} />}
      <ActionButton c={c} action={editing ? "close" : paused ? "edit" : "pause"} label={`${editing ? "Close" : paused ? "Edit" : "Pause"} ${group}`} onPress={() => setEditing(!editing)} /></View>
    {editing && <View style={{ gap: 8, padding: 12, backgroundColor: c.surface1, borderRadius: 7 }}>
      <Text style={{ ...muted(c), fontSize: 12 }}>{`${state.recentAssignments[group] ?? 0} recent · ${state.assignments[group] ?? 0} total`}</Text>
      {paused && current?.reason && <Text style={{ color: c.statusWarning }}>Reason: {current.reason}</Text>}
      <Field c={c} label="Reason" value={reason} onChange={setReason} placeholder="Usage limit reached" />
      <Field c={c} label="Retry at" value={retryAt} onChange={setRetryAt} placeholder="2026-09-12T09:00:00Z" />
      <Button small c={c} text={`Mark ${group} unavailable`} disabled={busy} onPress={() => void save({ group, unavailable: true, reason: reason || "Paused by operator", retryAt: retryAt || null })} />
    </View>}
  </View>;
}
