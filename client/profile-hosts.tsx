import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import { DropdownSelect, HostChip, muted, row, type Colors } from "./controls";
import { space, type as typeScale } from "./design";
import { createAutoSave, type AutoSave } from "../shared/autosave";
import * as api from "../shared/contracts";
import { hostModelFor, type NucleusProfile, type ProfileHostSetting, type ProfileHosts } from "../shared/profiles";
import type { HostFeature } from "../shared/host";
import type { HostKind } from "../shared/host-kind";

/**
 * Settings → Profiles' per-host status and mapping (nucleus#1151). The status
 * comes from `profile.compatibility`, the read the CLI shares; the editor
 * writes the profile's `hosts` setting and autosaves.
 */
export type CompatibilityRead = { hosts: api.ProfileCompatibilityHost[]; rows: api.ProfileCompatibilityRow[] };

/** The status words a chip's popover shows for one profile on one host. */
export function hostChipDetail(host: api.ProfileCompatibilityHost, row: api.ProfileCompatibilityRow | undefined): { ok: boolean; detail: string } {
  const offline = host.online ? "" : ` ${host.label} is offline; this is its last catalog.`;
  if (!row) return { ok: false, detail: `${host.label} has not reported yet.` };
  if (row.status === "works")
    return { ok: true, detail: `Works on ${host.label}${row.mapped.length ? ` with ${row.mapped.map(fieldWords).join(", ")} mapped` : ""}.${offline}` };
  return { ok: false, detail: `${row.reason}.${offline}` };
}

const FIELD_WORDS: Record<string, string> = { provider: "provider", model: "model", modeId: "mode", thinkingOptionId: "thinking", featureValues: "options" };
const fieldWords = (field: string) => FIELD_WORDS[field] ?? field;

/** One chip per host, shown only when Nucleus serves more than one host. */
export function ProfileHostChips({ c, profileId, name, read }: { c: Colors; profileId: string; name: string; read: CompatibilityRead | undefined }) {
  if (!read || read.hosts.length < 2) return null;
  return <View accessibilityLabel={`${name} hosts`} style={{ ...row, flexWrap: "nowrap" }}>
    {read.hosts.map(host => {
      const status = hostChipDetail(host, read.rows.find(item => item.profileId === profileId && item.hostId === host.hostId));
      return <HostChip key={host.hostId} c={c} text={host.label} ok={status.ok} detail={status.detail} label={`${name} on ${host.label}: ${status.ok ? "works" : "does not work"}`} />;
    })}
  </View>;
}

const SAME = { value: "", label: "Same as profile" };
const NONE = "\u0000none";
const SET = "set";

/** A setting with empty fields dropped; null when nothing is left. */
function cleanSetting(setting: ProfileHostSetting): ProfileHostSetting | null {
  const next = Object.fromEntries(Object.entries(setting).filter(([, value]) => value !== undefined)) as ProfileHostSetting;
  if (next.excluded === false) delete next.excluded;
  return Object.keys(next).length ? next : null;
}

function withSetting(hosts: ProfileHosts | undefined, kind: HostKind, setting: ProfileHostSetting | null): ProfileHosts | null {
  const next: ProfileHosts = { ...(hosts ?? {}) };
  if (setting) next[kind] = setting; else delete next[kind];
  return Object.keys(next).length ? next : null;
}

/**
 * The mapping or exclusion for each host other than the primary one, inside the
 * profile's editor. Every choice starts at "Same as profile"; a choice here
 * replaces the profile's own value on that host only.
 */
export function ProfileHostEditor({ c, profile, read, busy }: { c: Colors; profile: NucleusProfile; read: CompatibilityRead | undefined; busy: boolean }) {
  const queryClient = useQueryClient();
  const updateProfile = useRpc(api.updateNucleusProfile);
  const updateRef = useRef(updateProfile); updateRef.current = updateProfile;
  const [hosts, setHosts] = useState<ProfileHosts | undefined>(profile.hosts);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const saver = useRef<AutoSave<ProfileHosts | null> | null>(null);
  if (!saver.current) saver.current = createAutoSave(async value => {
    await updateRef.current({ id: profile.id, hosts: value });
    await queryClient.invalidateQueries({ queryKey: ["nucleus", "profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["nucleus", "state"] });
  }, next => { if (mounted.current) setStatus(next); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void saver.current!.flush(); }; }, []);
  const primaryKind = read?.hosts[0]?.kind;
  const others = (read?.hosts ?? []).filter((host, index, all) => host.kind !== primaryKind && all.findIndex(item => item.kind === host.kind) === index);
  if (!others.length) return null;
  const change = (kind: HostKind, patch: Partial<ProfileHostSetting>) => {
    const next = withSetting(hosts, kind, cleanSetting({ ...(hosts?.[kind] ?? {}), ...patch }));
    setHosts(next ?? undefined);
    saver.current!.enqueue(next);
  };
  const failed = status.startsWith("Not saved");
  return <View accessibilityLabel="Profile hosts" style={{ gap: space.sm }}>
    {others.map(host => <HostMapping key={host.kind} c={c} host={host} profile={profile} setting={hosts?.[host.kind] ?? {}} busy={busy}
      row={read!.rows.find(item => item.profileId === profile.id && item.hostId === host.hostId)} onChange={patch => change(host.kind, patch)} />)}
    {failed && <Text accessibilityLiveRegion="polite" style={{ ...muted(c), color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>{status}</Text>}
  </View>;
}

function HostMapping({ c, host, profile, setting, row: status, busy, onChange }: {
  c: Colors; host: api.ProfileCompatibilityHost; profile: NucleusProfile; setting: ProfileHostSetting;
  row: api.ProfileCompatibilityRow | undefined; busy: boolean; onChange: (patch: Partial<ProfileHostSetting>) => void;
}) {
  const chip = hostChipDetail(host, status);
  const providers = host.catalog?.providers ?? [];
  const providerKey = setting.provider ?? status?.launch?.provider ?? profile.provider;
  const provider = providers.find(candidate => candidate.key === providerKey) ?? null;
  const modelId = setting.model ?? profile.model;
  const model = provider ? hostModelFor(modelId, provider) : null;
  const excluded = setting.excluded === true;
  const optionsSet = setting.featureValues !== undefined;
  const features = model?.features ?? [];
  const featureValue = (feature: HostFeature) => setting.featureValues?.[feature.id];
  const setFeature = (feature: HostFeature, value: unknown) => {
    const next = { ...(setting.featureValues ?? {}) };
    if (value === undefined) delete next[feature.id]; else next[feature.id] = value;
    onChange({ featureValues: next });
  };
  const half = { flex: 1, minWidth: 160 };
  const cells: { key: string; node: React.ReactNode }[] = excluded ? [] : [
    { key: "provider", node: <DropdownSelect label="Provider" value={setting.provider ?? ""} c={c} disabled={busy}
      options={[SAME, ...providers.map(candidate => ({ value: candidate.key, label: candidate.label || candidate.key }))]}
      onChange={value => onChange({ provider: value || undefined, model: undefined, modeId: undefined, thinkingOptionId: undefined })} /> },
    { key: "model", node: <DropdownSelect label="Model" value={setting.model ?? ""} c={c} disabled={busy || !provider}
      options={[SAME, ...(provider?.models ?? []).map(candidate => ({ value: candidate.id, label: candidate.label || candidate.id }))]}
      onChange={value => onChange({ model: value || undefined })} /> },
    ...(model?.modes.length ? [{ key: "mode", node: <DropdownSelect label="Mode" value={setting.modeId === null ? NONE : setting.modeId ?? ""} c={c} disabled={busy}
      options={[SAME, { value: NONE, label: "Host default" }, ...model.modes.map(mode => ({ value: mode.id, label: mode.label || mode.id }))]}
      onChange={value => onChange({ modeId: value === NONE ? null : value || undefined })} /> }] : []),
    { key: "thinking", node: <DropdownSelect label="Thinking" value={setting.thinkingOptionId === null ? NONE : setting.thinkingOptionId ?? ""} c={c} disabled={busy}
      options={[SAME, { value: NONE, label: "None" }, ...(model?.thinkingOptions ?? []).map(option => ({ value: option.id, label: option.label || option.id }))]}
      onChange={value => onChange({ thinkingOptionId: value === NONE ? null : value || undefined })} /> },
    ...(features.length || Object.keys(profile.featureValues ?? {}).length ? [{ key: "options", node: <DropdownSelect label="Options" value={optionsSet ? SET : ""} c={c} disabled={busy}
      options={[SAME, { value: SET, label: "Set here" }]} onChange={value => onChange({ featureValues: value === SET ? setting.featureValues ?? {} : undefined })} /> }] : []),
    ...(optionsSet ? features.map(feature => ({ key: `feature:${feature.id}`, node: <DropdownSelect label={feature.label} c={c} disabled={busy}
      value={featureValue(feature) === undefined ? "" : String(featureValue(feature))}
      options={[{ value: "", label: "Host default" }, ...(feature.type === "toggle" ? [{ value: "true", label: "On" }, { value: "false", label: "Off" }]
        : feature.options.map(option => ({ value: option.id, label: option.label || option.id })))]}
      onChange={value => setFeature(feature, value === "" ? undefined : feature.type === "toggle" ? value === "true" : value)} /> })) : []),
  ];
  return <View accessibilityLabel={`${host.label} mapping`} style={{ gap: space.xs, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ ...row, flexWrap: "nowrap", alignItems: "flex-end" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <DropdownSelect label={host.label} value={excluded ? "exclude" : "use"} c={c} disabled={busy}
          options={[{ value: "use", label: "Use" }, { value: "exclude", label: "Exclude" }]}
          onChange={value => onChange({ excluded: value === "exclude" ? true : undefined })} />
      </View>
      <View style={{ paddingBottom: space.xs }}>
        <HostChip c={c} text={chip.ok ? "Works" : excluded ? "Excluded" : "Doesn't work"} ok={chip.ok} detail={chip.detail} label={`${profile.name} on ${host.label}`} />
      </View>
    </View>
    {Array.from({ length: Math.ceil(cells.length / 2) }, (_, i) => cells.slice(i * 2, i * 2 + 2)).map(pair =>
      <View key={pair.map(cell => cell.key).join("|")} style={{ ...row, columnGap: 16, rowGap: 12, alignItems: "flex-end" }}>
        {pair.map(cell => <View key={cell.key} style={half}>{cell.node}</View>)}
      </View>)}
  </View>;
}
