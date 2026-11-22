import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Field, HelpPopover, HelpTip, muted, row, type Colors } from "./controls";
import { space, type } from "./design";
import type { WorkStorageInput, WorkStorageState } from "../shared/schema/work-storage";

/** One class the Storage page edits: its resolved path, its settings key and what lives there. */
type StorageClass = {
  field: keyof WorkStorageState["defaults"];
  setting: string;
  noun: string;
  help: string;
};

const CLASSES: readonly StorageClass[] = [
  {
    field: "worktreesRoot",
    setting: "localWorkspaceRoot",
    noun: "Task worktrees",
    help: "Every local task workspace is allocated here, one directory per repository and task. Workspaces recorded under the retired queue/workspaces stay supported for continuation and cleanup.",
  },
  {
    field: "backupRoot",
    setting: "backupRoot",
    noun: "Database backups",
    help: "Nucleus writes and rotates its verified store snapshots here. Snapshots still in the retired queue/backups location are listed until you move or remove them.",
  },
  {
    field: "projectQaRoot",
    setting: "projectQaRoot",
    noun: "QA history",
    help: "Legacy milestone QA results and step logs. History in the retired queue/project-qa location stays readable.",
  },
  {
    field: "scratchRoot",
    setting: "scratchRoot",
    noun: "Run scratch",
    help: "Each run's own temporary directory lives here, so two concurrent runs never share a temp root.",
  },
  {
    field: "custodianRoot",
    setting: "custodianRoot",
    noun: "Custodian records",
    help: "The start and stop handshake files for a Barge lease custodian. They carry one live lease and are removed when it is returned; an in-flight lease keeps the paths it recorded, so a retired queue/barge-custodians directory is never read.",
  },
];

/** The empty draft means the portable default; a typed path overrides it. */
const draftOf = (state: WorkStorageState): Record<string, string> =>
  Object.fromEntries(CLASSES.map(item => [item.field, state.overrides[item.field] ?? ""]));

/**
 * Settings → Storage (nucleus#1526): every location Nucleus writes on the work
 * volume is one path setting with a portable default derived from the work root.
 * The service validates each path on save — canonical, absolute, inside the work
 * root, on the pinned volume, no symlinks — and explains a refusal here. A saved
 * change applies the next time the service starts.
 */
export function StoragePanel({ c, state, loading, loadError, save, inset }: {
  c: Colors;
  state: WorkStorageState | undefined;
  loading: boolean;
  loadError: unknown;
  /** Persist one save and answer with the placement now on disk. */
  save: (input: WorkStorageInput) => Promise<WorkStorageState>;
  inset: number;
}) {
  const [workRoot, setWorkRoot] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  // The drafts are the values `settings.json` holds, never the resolved placement:
  // an environment override is shown as the effective path, not carried into a
  // field, so saving cannot make a variable's value durable.
  const loaded = useRef<WorkStorageState | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    loaded.current = state;
    setWorkRoot(state.overrides.workRoot ?? "");
    setDrafts(draftOf(state));
  }, [state]);
  const savedAt = loaded.current;
  const dirty = Boolean(savedAt) && (workRoot !== (savedAt!.overrides.workRoot ?? "")
    || CLASSES.some(item => (drafts[item.field] ?? "") !== (savedAt!.overrides[item.field] ?? "")));
  const invalid = CLASSES.find(item => failure.includes(item.setting));
  const problem = failure || (loadError ? `Couldn't load the storage paths: ${errorText(loadError)}` : null);
  const help = "Nucleus keeps its work on one volume. Every path here has a portable default under the work root, and each one must be absolute, inside the work root, on that volume and free of symlinks. "
    + "Saved changes apply the next time the service starts; a refused path is not written. The environment variables NUCLEUS_WORK_ROOT, NUCLEUS_LOCAL_WORKSPACE_ROOT, NUCLEUS_BACKUP_ROOT, NUCLEUS_PROJECT_QA_ROOT, NUCLEUS_SCRATCH_ROOT and NUCLEUS_CUSTODIAN_ROOT override these values without changing this file.";
  async function persist(input: WorkStorageInput) {
    setSaving(true);
    setFailure("");
    setSaved(false);
    try {
      const next = await save(input);
      loaded.current = next;
      setWorkRoot(next.overrides.workRoot ?? "");
      setDrafts(draftOf(next));
      setSaved(true);
    } catch (error) {
      setFailure(errorText(error));
      throw error;
    } finally {
      setSaving(false);
    }
  }
  async function press() {
    const baseline = loaded.current;
    if (!baseline) return;
    const input: WorkStorageInput = {};
    // Only a field the operator changed is sent, so an untouched class keeps
    // whatever `settings.json` holds (including nothing at all).
    if (workRoot !== (baseline.overrides.workRoot ?? "")) input.workRoot = workRoot ? workRoot : null;
    for (const item of CLASSES) {
      const value = drafts[item.field] ?? "";
      if (value === (baseline.overrides[item.field] ?? "")) continue;
      input[item.field] = value ? value : null;
    }
    if (!Object.keys(input).length) return;
    await persist(input).catch(() => {});
  }
  async function reset() {
    const input: WorkStorageInput = {};
    for (const item of CLASSES) input[item.field] = null;
    await persist(input).catch(() => {});
  }
  return <ScrollView accessibilityLabel="Storage" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: space.sm, paddingBottom: inset, width: "100%", maxWidth: 780 }}>
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: type.section.fontSize, fontWeight: "600" }}>Storage</Text>
      <HelpTip c={c} label="Storage" text={help} open={helpOpen} onOpenChange={setHelpOpen} />
      <View style={{ flex: 1 }} />
      <Button c={c} small text="Reset paths" disabled={saving || !state} hint="Restore every class default under the work root" onPress={() => void reset()} />
    </View>
    {helpOpen && <HelpPopover c={c} anchor={anchor} label="Storage" text={help} />}
    <Text style={muted(c)}>Changes apply when the Nucleus service next starts.</Text>
    {!state && loading && <Text style={muted(c)}>Loading storage paths…</Text>}
    {problem && <Text accessibilityRole="alert" selectable style={{ color: c.statusWarning, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{problem}</Text>}
    {state && <>
      <Field c={c} label="Work root" value={workRoot} onChange={value => { setWorkRoot(value); setSaved(false); }}
        placeholder={state.workRoot} disabled={saving}
        invalid={failure.includes("workRoot")}
        detail={`The volume mount every other path sits inside · in force now: ${state.workRoot}`} />
      {CLASSES.map(item => {
        const stored = state.overrides[item.field];
        const inForce = state[item.field] !== (stored ?? state.defaults[item.field]);
        return <Field key={item.field} c={c} label={item.noun} value={drafts[item.field] ?? ""}
          onChange={value => { setDrafts(current => ({ ...current, [item.field]: value })); setSaved(false); }}
          placeholder={state[item.field]} disabled={saving} invalid={invalid === item}
          detail={`Default: ${state.defaults[item.field]}${inForce ? ` · environment override in force: ${state[item.field]}` : ""}`} />;
      })}
      <View style={{ ...row, flexWrap: "nowrap", marginTop: space.xxs }}>
        <Button c={c} text={saving ? "Saving…" : "Save paths"} disabled={saving || !dirty}
          hint={dirty ? "Validate and save these paths" : "No path has changed"} onPress={() => void press()} />
        {saved && <Text style={muted(c)}>Saved. Applies on the next service start.</Text>}
      </View>
      <View style={{ marginTop: space.sm, gap: space.xxs }}>
        <Text style={muted(c)}>Retired locations still read</Text>
        <Text selectable accessibilityLabel="Retired locations" style={{ color: c.foreground, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>
          {[state.retired.worktreesRoot, state.retired.backupRoot, state.retired.projectQaRoot]
            .filter(Boolean).join(" · ")}
        </Text>
      </View>
    </>}
  </ScrollView>;
}
