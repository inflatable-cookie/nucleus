import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import { ActionButton, Button, Field, Section, muted, row, type Colors } from "./controls";
import { space, type as typeScale, radius } from "./design";
import * as api from "../shared/contracts";
import { errorText as failureText } from "./error-text";
import { activeGroupLimit, removePoolEntry, stalePoolEntries } from "../shared/pool";
import type { PoolEntry, Profile, Project, RepositorySettings, UiQueueState } from "../shared/contracts";
import { hostModelFor, type NucleusProfile } from "../shared/profiles";
import type { HostCatalog } from "../shared/host";
import { ProfileEditor, ProfileRow, quietSaveStatus } from "./settings-profile-editor";
import { catalogAge, defaultPoolEntry, modelWords, profileRowStatus, type CatalogRead } from "./settings-profile-helpers";

export function ProfilesPanel({ c, compact, inset, state, repositories, busy, savePool, savePoolList, saveAvailability }: {
  c: Colors; compact: boolean; inset: number; state: UiQueueState | null; repositories: RepositorySettings[];
  busy: boolean; savePool: (entry: PoolEntry) => Promise<void>; savePoolList: (entries: PoolEntry[]) => Promise<boolean>;
  saveAvailability: (value: UiQueueState["availability"][number]) => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const fetchCompatibility = useRpc(api.readProfileCompatibility);
  // The form's choices: every registered host's catalog in canonical values (task 1158).
  const fetchProfiles = useRpc(api.listNucleusProfiles), fetchCatalog = useRpc(api.readProfileVocabulary);
  const createProfile = useRpc(api.createNucleusProfile), removeProfile = useRpc(api.removeNucleusProfile);
  const directories = [...new Set(repositories.map(row => row.repository.path).filter(path => path.length > 0))];
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<string | "new" | null>(null);
  const [created, setCreated] = useState<NucleusProfile | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const editorKey = editor === "new" ? "new" : editor ?? "";
  const directory = lastUsed[editorKey] && directories.includes(lastUsed[editorKey]!) ? lastUsed[editorKey]! : directories[0] ?? null;
  const profilesQuery = useQuery({ queryKey: ["nucleus", "profiles"], queryFn: () => fetchProfiles({}) });
  // Under the profiles key, so every profile write's invalidation refreshes it too.
  const compatibilityQuery = useQuery({ queryKey: ["nucleus", "profiles", "compatibility"], queryFn: () => fetchCompatibility({}), staleTime: 15_000 });
  const compatibility = compatibilityQuery.data;
  const catalogQuery = useQuery({ queryKey: ["nucleus", "profile-vocabulary", directory ?? ""], queryFn: () => fetchCatalog(directory ? { cwd: directory } : {}), staleTime: 30_000 });
  const catalogsQuery = useQuery({
    queryKey: ["nucleus", "profile-vocabularies", directories.join("|")],
    queryFn: () => Promise.all(directories.map(async cwd => ({ cwd, catalog: await fetchCatalog({ cwd }) }))),
    enabled: editor !== null && directories.length > 1, staleTime: 30_000,
  });
  const catalog = catalogQuery.data;
  const catalogs = catalogsQuery.data ?? (directory && catalog ? [{ cwd: directory, catalog }] : []);
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
  const panelBusy = busy || Boolean(removing);
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
      for (const read of reads) if (read.status === "fulfilled") queryClient.setQueryData(["nucleus", "profile-vocabulary", read.value.cwd ?? ""], read.value.catalog);
      const failed = reads.find(read => read.status === "rejected");
      if (failed) setRefreshError(failureText(failed.reason));
      await queryClient.invalidateQueries({ queryKey: ["nucleus", "profile-vocabularies"] });
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
  const stale = state ? stalePoolEntries(state.pool, state.connected ? state.profiles : []) : [];
  const groups = state ? [...new Set(state.pool.map(entry => entry.group))] : [];
  // Profile and stale rows draw their own divider; a trailing loading or empty line does not.
  const profilesEndInRow = live.length > 0 || (stale.length > 0 && editor === "new" && !profilesQuery.isPending);
  return <ScrollView accessibilityLabel="Profiles page" style={{ flex: 1, minHeight: 0, width: compact ? "auto" : "100%", maxWidth: "100%" }} contentContainerStyle={{ paddingBottom: inset, width: "100%", maxWidth: 780 }}>
    {refreshError && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>Refresh failed: {refreshError}. The stored providers and models stay.</Text>}
    {catalogQuery.error && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>The providers and models could not be read: {failureText(catalogQuery.error)}</Text>}
    {profilesQuery.error && <Text accessibilityRole="alert" style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>Could not read profiles: {failureText(profilesQuery.error)}</Text>}
    <Section c={c} title="Profiles" label="Stored profiles" status={quietSaveStatus(actionStatus) || null} endsInRow={profilesEndInRow}
      description="A profile is a provider and model a registered host can run, and how Nucleus uses it for dispatch. Each host translates it to its own names. Cost and capability sit in the editor."
      action={<View style={{ ...row, flexWrap: "nowrap" }}>
        <ActionButton c={c} action="refresh" tip={refreshText} label="Refresh providers and models" busy={refreshing} onPress={() => void refreshCatalog()} />
        <ActionButton c={c} action="add" label="Add profile" disabled={panelBusy || editor === "new"} onPress={() => setEditor("new")} />
      </View>}>
      {editor === "new" && <ProfileEditor key="new" c={c} catalog={catalog} catalogs={catalogs} directory={directory}
        projects={state?.projects ?? []} repositories={repositories} initial={null} entry={null} state={state}
        busy={panelBusy} poolSaveStatus="" onCreated={profile => { setCreated(profile); setEditor(profile.id); }} onChooseDirectory={chooseDirectory}
        onClose={() => setEditor(null)} />}
      {live.map(item => <ProfileRow key={item.id} c={c} profile={item.stored ?? item.board!} board={item.board} stored={item.stored} compatibility={compatibility} catalog={catalog}
        catalogs={catalogs} directory={directory} projects={state?.projects ?? []} repositories={repositories}
        state={state} busy={panelBusy} editing={editor === item.id} poolSave={savePool}
        onEdit={() => setEditor(editor === item.id ? null : item.id)} onCreated={profile => { setCreated(profile); setEditor(profile.id); }}
        onDuplicate={() => void duplicate(item.stored ?? item.board!)} onRemove={() => remove(item.id)} onChooseDirectory={chooseDirectory}
        actionStatus={actionStatus} />)}
      {stale.map(entry => <StalePoolEntry key={entry.profileId} c={c} entry={entry} busy={panelBusy} onRemove={() => void savePoolList(removePoolEntry(state!.pool, entry.profileId))} />)}
      {profilesQuery.isPending && !live.length && <Text style={muted(c)}>Reading profiles…</Text>}
      {!live.length && !profilesQuery.isPending && editor !== "new" && <Text style={muted(c)}>No profiles yet. Add one from what your hosts can run.</Text>}
    </Section>
    <View>
      <Section c={c} title="Subscriptions" label="Subscriptions" last endsInRow={Boolean(state && groups.length)}
        description="Profiles that share a provider subscription form one group. An unavailable group leaves selection until its retry time or a reset.">
        {!state && <Text style={muted(c)}>Reading subscriptions…</Text>}
        {state && !groups.length && <Text style={muted(c)}>None yet. Add a profile first.</Text>}
        {state && groups.map(group => <Availability key={`${group}-${JSON.stringify(state.availability.find(a => a.group === group))}`} c={c} group={group} state={state} busy={busy} save={saveAvailability} />)}
      </Section>
    </View>
  </ScrollView>;
}

function StalePoolEntry({ c, entry, busy, onRemove }: { c: Colors; entry: PoolEntry; busy: boolean; onRemove: () => void }) {
  return <View style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: space.xs, gap: space.xs }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <Text style={{ flex: 1, minWidth: 0, color: c.foreground, fontWeight: "600", fontSize: typeScale.body.fontSize }}>{entry.profileId}</Text>
      <ActionButton c={c} action="remove" label={`Remove ${entry.profileId}`} disabled={busy} onPress={onRemove} />
    </View>
    <Text style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>This profile is gone</Text>
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
  return <View style={{ gap: space.xs, paddingVertical: space.xs, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={row}><Text style={{ color: c.foreground, fontWeight: "600", flex: 1 }}>{group}</Text>
      <Text style={{ color: paused ? c.statusWarning : c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>{paused ? current?.retryAt ? `Unavailable until ${new Date(current.retryAt).toLocaleString()}` : "Unavailable" : "Available"}</Text>
      {paused && <Button small c={c} text={`Reset ${group}`} disabled={busy} onPress={() => void save({ group, unavailable: false, reason: "Reset by operator", retryAt: null })} />}
      <ActionButton c={c} action={editing ? "close" : paused ? "edit" : "pause"} label={`${editing ? "Close" : paused ? "Edit" : "Pause"} ${group}`} onPress={() => setEditing(!editing)} /></View>
    {editing && <View style={{ gap: space.xs, padding: space.sm, backgroundColor: c.surface1, borderRadius: radius.control }}>
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{`${state.recentAssignments[group] ?? 0} recent · ${state.assignments[group] ?? 0} total`}</Text>
      {paused && current?.reason && <Text style={{ color: c.statusWarning }}>Reason: {current.reason}</Text>}
      <Field c={c} label="Reason" value={reason} onChange={setReason} placeholder="Usage limit reached" />
      <Field c={c} label="Retry at" value={retryAt} onChange={setRetryAt} placeholder="2026-09-12T09:00:00Z" />
      <Button small c={c} text={`Mark ${group} unavailable`} disabled={busy} onPress={() => void save({ group, unavailable: true, reason: reason || "Paused by operator", retryAt: retryAt || null })} />
    </View>}
  </View>;
}
