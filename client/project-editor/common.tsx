import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import { ActionButton, Button, DropdownSelect, Field, FieldCaption, HelpPopover, HelpTip, InlineConfirm, muted, row, type Colors } from "../controls";
import { roles, space, type } from "../design";
import { errorText } from "../error-text";
import { formatLocalDateTime } from "../../shared/date-time";
import { withoutHostPaths } from "../project-helpers";
import type { ProjectAgentView, Project } from "../../shared/contracts";
import type { OwnerCandidate, ProjectEditActions } from "./types";

const NONE = "__none__";

/** Two columns where they fit (688 and wider), one at 390. */
export function Pair({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "flex-start" }}>
    {React.Children.toArray(children).map((child, index) => <View key={index} style={{ flexGrow: 1, flexBasis: 260, minWidth: 0, gap: space.xs }}>{child}</View>)}
  </View>;
}

/** "Saved", or "Not saved" with its reason behind a (?). Saving… stays quiet. */
export function SaveWord({ c, status, name }: { c: Colors; status: string; name: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const r = roles(c);
  if (status === "Saved") return <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Saved</Text>;
  const refreshFailurePrefix = "Saved, but refresh failed:";
  const wrappedRefreshFailurePrefix = `Not saved: ${refreshFailurePrefix}`;
  const wrappedRefreshFailure = status.startsWith(wrappedRefreshFailurePrefix);
  const refreshFailed = wrappedRefreshFailure || status.startsWith(refreshFailurePrefix);
  if (!refreshFailed && !status.startsWith("Not saved")) return null;
  const reason = refreshFailed
    ? status.slice(wrappedRefreshFailure ? wrappedRefreshFailurePrefix.length : refreshFailurePrefix.length).replace(/\. Change the field to retry\.$/, "").trim()
    : status.replace(/^Not saved:\s*/, "");
  const label = refreshFailed ? "Refresh failed" : "Not saved";
  return <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
    <Text accessibilityLabel={`${name} save status`} accessibilityLiveRegion="polite" style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{label}</Text>
    <HelpTip c={c} label={label} text={reason} open={open} onOpenChange={setOpen} />
    {open && <HelpPopover c={c} anchor={anchor} label={label} text={reason} />}
  </View>;
}

/** Task 1110: the project's named, non-task threads, and the form that registers one from the board. */
export function AgentsSection({ c, project, agents, disabled, actions, r }: {
  c: Colors; project: Project; agents: ProjectAgentView[]; disabled: boolean; actions: ProjectEditActions; r: ReturnType<typeof roles>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [thread, setThread] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  // Non-task threads only: a task worker or reviewer is addressed by its task.
  const chosen = (actions.candidates.data ?? []).filter(candidate => candidate.kind === "planner" || candidate.kind === "other");
  const refresh = () => actions.refresh().catch(error => setFailure(withoutHostPaths(errorText(error))));
  const register = async () => {
    if (!thread || !name.trim() || !purpose.trim()) { setFailure("A name, a purpose and a thread are required"); return; }
    setBusy(true); setFailure("");
    try {
      await actions.registerAgent({ project: project.key, name: name.trim(), purpose: purpose.trim(), agentId: thread });
      setAdding(false); setName(""); setPurpose(""); setThread(null);
      await refresh();
    } catch (error) { setFailure(withoutHostPaths(errorText(error))); }
    finally { setBusy(false); }
  };
  const unregister = async (agent: string) => {
    setRemoving(null); setBusy(true); setFailure("");
    try { await actions.unregisterAgent({ project: project.key, name: agent }); await refresh(); }
    catch (error) { setFailure(withoutHostPaths(errorText(error))); }
    finally { setBusy(false); }
  };
  return <View accessibilityLabel={`Agents for ${project.name}`} style={{ gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: r.border }}>
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, flex: 1 }}>Agents</Text>
      <ActionButton c={c} action="add" label="Register agent" disabled={disabled || busy || !chosen.length} onPress={() => setAdding(true)} />
    </View>
    <Text style={muted(c)}>Named, non-task threads other threads address by name: planners, leads and cross-section coordinators.</Text>
    {adding && <View style={{ gap: space.xs }}>
      <Field c={c} label="Agent name" a11yLabel="Agent name" value={name} onChange={setName} detail="Lowercase letters, digits and dashes" />
      <Field c={c} label="Purpose" a11yLabel="Agent purpose" value={purpose} onChange={setPurpose} />
      <DropdownSelect c={c} label="Thread" value={thread ?? NONE} options={[{ value: NONE, label: "Choose a live thread" }, ...chosen.map(candidate => ({ value: candidate.id, label: candidate.title.trim() || candidate.id }))]}
        onChange={value => setThread(value === NONE ? null : value)} />
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <Button small c={c} text="Register" label="Save agent registration" disabled={busy} onPress={() => void register()} />
        <Button small c={c} text="Cancel" label="Cancel agent registration" disabled={busy} onPress={() => { setAdding(false); setFailure(""); }} />
      </View>
    </View>}
    {agents.length === 0 && !adding && <Text style={muted(c)}>No named agents yet.</Text>}
    {agents.map(agent => <View key={agent.name} style={{ ...row, flexWrap: "nowrap", paddingVertical: space.xxs }} accessibilityLabel={`Agent ${agent.name}, ${agent.state}`}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{agent.name}{agent.fallback ? " · fallback planner" : ""}</Text>
        <Text numberOfLines={2} style={{ color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{agent.purpose}</Text>
        <Text style={{ color: agent.state === "gone" || agent.state === "archived" ? r.warning : r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>
          {stateWord(agent.state)}{agent.lastSeen ? ` · last seen ${formatLocalDateTime(agent.lastSeen)}` : ""}
        </Text>
      </View>
      <ActionButton c={c} action="remove" label={`Unregister ${agent.name}`} disabled={disabled || busy} onPress={() => setRemoving(agent.name)} />
    </View>)}
    {removing && <InlineConfirm c={c} question={`Unregister ${removing}? Its participant ticket stops working.`} confirmLabel="Unregister" label={`agent ${removing}`}
      busy={busy} onConfirm={() => void unregister(removing)} onCancel={() => setRemoving(null)} />}
    {failure && <Text accessibilityRole="alert" style={{ color: r.danger, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{failure}</Text>}
  </View>;
}

const stateWord = (state: ProjectAgentView["state"]): string =>
  state === "running" ? "Running" : state === "idle" ? "Idle" : state === "archived" ? "Archived" : state === "gone" ? "Gone" : "Unknown";

/** The planner picker: live standing threads by title, plus None. A planner that is not live stays selected as "Gone". */
