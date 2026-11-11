import { errorText as message } from "./error-text";
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { BoardLead, LaneDocumentVersion, LaneView, Project, ProjectPlan, TaskSummary } from "../shared/contracts";
import { formatLocalDateTime } from "../shared/date-time";
import { phaseStateLabel } from "../shared/task-state";
import { Button, row, type Colors } from "./controls";
import { radius, roles, space, type } from "./design";
import { LaneProjects } from "./planning-panel";
import { Readable } from "./readable-text";

/** The latest document as read. `null` is a lane with no document yet; `undefined` is not loaded. */
export type LaneDocumentRead = { data?: LaneDocumentVersion | null; error?: string };
/** A list as read. `items` is undefined until the first read completes, so loading never looks like an empty list. */
export type LaneListRead<T> = { items?: T[]; error?: string; total?: number; offset?: number; nextOffset?: number | null };
/**
 * Unsaved document text. It lives above the screen so it survives leaving the Planning tab. `base` is the
 * version the text was written against and `start` is that version's text, so an unchanged draft is not saved.
 */
export type LaneDraft = { base: number; text: string; start: string };

type Section = "work" | "leads" | "papercuts";
type Mode = "preview" | "read" | "edit";

export const LANE_PREVIEW_LINES = 8;
export const LANE_PREVIEW_CHARS = 600;

/** The opening of a document for the lane's preview. `truncated` says there is more to read in full. */
export function lanePreview(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const truncated = lines.length > LANE_PREVIEW_LINES || text.length > LANE_PREVIEW_CHARS;
  return { text: truncated ? lines.slice(0, LANE_PREVIEW_LINES).join("\n").slice(0, LANE_PREVIEW_CHARS) : text, truncated };
}

/** Papercuts are leads tagged `papercut`; the lane screen lists them apart from other leads. */
export const isPapercut = (lead: Pick<BoardLead, "tags">) => lead.tags.includes("papercut");
/** Live tasks across every phase. The server computes these from the whole lane, so the total is complete. */
export const liveTaskCount = (lane: Pick<LaneView, "liveByPhase">) => Object.values(lane.liveByPhase).reduce((sum, count) => sum + count, 0);

const statusWord: Record<LaneView["status"], string> = { active: "Active", paused: "Paused", done: "Done", abandoned: "Abandoned" };

/**
 * Lead and papercut lists show one page of eight at a time. The caller's read is complete,
 * so the count and the "showing N of M" line are true totals, never a first page dressed as one.
 */
export const LANE_LIST_PAGE = 8;

/** One related list: loading, failed, empty and loaded are distinct, and a failed read never shows a count. */
function RecordList({ read, label, empty, describe, shown, onShowMore, onOpen, onRetry, c }: {
  read: LaneListRead<BoardLead>; label: string; empty: string; describe: (lead: BoardLead) => string;
  shown: number; onShowMore: () => void;
  onOpen: (lead: BoardLead) => void; onRetry?: () => void; c: Colors;
}) {
  const r = roles(c);
  const meta = { color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight };
  const retry = onRetry && <View style={row}><Button small c={c} text="Retry" label={`Retry loading ${label}`} onPress={onRetry} /></View>;
  if (read.items === undefined) return read.error
    ? <View accessibilityRole="alert" style={{ gap: space.xs, padding: space.sm, borderRadius: radius.control, borderWidth: 1, borderColor: r.danger, backgroundColor: r.section }}>
      <Text style={{ color: r.foreground }}>Couldn’t load {label}: {read.error}</Text>
      <Text style={meta}>Nothing here is a total until it loads.</Text>
      {retry}
    </View>
    : <Text style={meta}>Loading {label}…</Text>;
  return <View style={{ gap: space.xs }}>
    {read.error && <View accessibilityRole="alert" style={{ gap: space.xxs }}>
      <Text style={{ color: r.warning, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>Showing the last {label} read. It may be out of date: {read.error}</Text>
      {retry}
    </View>}
    {!read.items.length && <Text style={meta}>{empty}</Text>}
    {read.items.length > shown && <Text style={meta}>Showing {shown} of {read.items.length} {label}.</Text>}
    {read.items.slice(0, shown).map(lead => <Pressable key={lead.id} accessibilityRole="button" accessibilityLabel={`Open ${label.replace(/s$/, "")} ${lead.title}`} onPress={() => onOpen(lead)}
      style={{ gap: space.xxs, padding: space.sm, borderRadius: radius.card, borderWidth: 1, borderColor: r.border, backgroundColor: r.section }}>
      <Text numberOfLines={2} style={{ color: r.foreground, fontWeight: "600", fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{lead.title}</Text>
      <Text style={meta}>{describe(lead)}</Text>
    </Pressable>)}
    {read.items.length > shown && <View style={row}><Button small c={c} text={`Show ${Math.min(LANE_LIST_PAGE, read.items.length - shown)} more ${label}`} onPress={onShowMore} /></View>}
  </View>;
}

/**
 * The lane's own screen (nucleus#867): its aim, a preview of its document with a readable full
 * text and version-safe editing, and its work, leads and papercuts. Each related record opens its
 * existing detail. Counts appear only where the read is complete; loading, failed and stale reads
 * say so. Raw keys and repositories sit behind Details.
 *
 * Wide puts the document beside the related lists; narrow stacks them. Reading and editing take the
 * whole lane column, with Back to the lane beside them.
 */
export function LaneScreen({ lane, compact, projects, plans, selected, busy, canEdit, doc, draft, onDraft, onSaveDocument, onRetryDocument, readVersion, tasks, leads, onOpenTask, onOpenLead, onRetryLeads, onLoadMoreTasks, onLoadPreviousTasks, onRetryTasks, onSelectProject, onSetStatus, c }: {
  lane: LaneView; compact: boolean; projects: Project[]; plans: ProjectPlan[]; selected: readonly string[]; busy: boolean;
  /** Whether the operator may write the lane document. */
  canEdit: boolean;
  doc: LaneDocumentRead; draft: LaneDraft | null; onDraft: (draft: LaneDraft | null) => void;
  /** Saves `text` as the next version after `version`. Rejects when the save is refused; the draft is kept. */
  onSaveDocument: (input: { version: number; text: string }) => Promise<void>; onRetryDocument: () => void;
  readVersion: (version: number) => Promise<LaneDocumentVersion | null>;
  tasks: LaneListRead<TaskSummary>; leads: LaneListRead<BoardLead>;
  onOpenTask: (id: string) => void; onOpenLead: (lead: BoardLead) => void; onRetryLeads?: () => void;
  onLoadMoreTasks?: (offset: number) => void;
  onLoadPreviousTasks?: () => void; onRetryTasks?: () => void;
  onSelectProject?: (key: string) => void; onSetStatus?: (status: LaneView["status"]) => void;
  c: Colors;
}) {
  const r = roles(c);
  const [section, setSection] = useState<Section>("work");
  const [mode, setMode] = useState<Mode>(draft ? "edit" : "preview");
  const [pastVersion, setPastVersion] = useState<number | null>(null);
  const [past, setPast] = useState<{ version: number; document?: LaneDocumentVersion | null; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [details, setDetails] = useState(false);
  // Lead and papercut lists page eight at a time from the lane's complete read.
  const [listShown, setListShown] = useState<{ leads: number; papercuts: number }>({ leads: LANE_LIST_PAGE, papercuts: LANE_LIST_PAGE });
  const latest = doc.data;
  const latestVersion = latest?.version ?? 0;
  const loaded = doc.data !== undefined;
  const name = lane.title;
  const text = { color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight } as const;
  const meta = { color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight } as const;
  const panel = { gap: space.xs, padding: space.sm, borderRadius: radius.control, borderWidth: 1, borderColor: r.border, backgroundColor: r.section } as const;
  const alertPanel = { ...panel, borderColor: r.warning } as const;
  // Edit mode without a draft has nothing to edit; the screen shows the document instead.
  const shown: Mode = mode === "edit" && !draft ? "preview" : mode;
  // The draft is based on an older version than the latest: saving it now would overwrite newer text.
  const conflict = Boolean(draft && loaded && latestVersion !== draft.base);
  const unchanged = Boolean(draft && draft.text === draft.start && draft.base === latestVersion);
  const saveBlock = !draft ? "" : conflict ? "The document changed. Use the latest version as the base first." : unchanged ? "No changes to save." : "";

  // A version read for history. Only the one the operator is looking at is fetched.
  useEffect(() => {
    if (pastVersion === null) { setPast(null); return; }
    let live = true;
    setPast(null);
    readVersion(pastVersion).then(
      found => { if (live) setPast({ version: pastVersion, document: found }); },
      error => { if (live) setPast({ version: pastVersion, error: message(error) }); });
    return () => { live = false; };
  }, [pastVersion]);

  const save = async () => {
    if (!draft || saveBlock) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSaveDocument({ version: draft.base, text: draft.text });
      onDraft(null);
      setMode("preview");
    } catch (error) {
      setSaveError(message(error));
    } finally {
      setSaving(false);
    }
  };
  const startEdit = () => {
    // An existing draft is kept, so Edit never silently replaces unsaved text.
    if (!draft) onDraft({ base: latestVersion, text: latest?.text ?? "", start: latest?.text ?? "" });
    setSaveError("");
    setMode("edit");
  };
  const discard = () => { onDraft(null); setSaveError(""); setMode("preview"); setPastVersion(null); };
  const back = () => { setMode("preview"); setPastVersion(null); };

  const liveTotal = liveTaskCount(lane);
  const workTotal = tasks.total ?? liveTotal;
  const leadItems = leads.items?.filter(lead => !isPapercut(lead));
  const cutItems = leads.items?.filter(isPapercut);
  const leadRead = { items: leadItems, error: leads.error };
  const cutRead = { items: cutItems, error: leads.error };
  const countLabel = (label: string, count: number | undefined) => count === undefined ? label : `${label} · ${count}`;
  const segment = (key: Section, label: string, count: number | undefined) => <Button key={key} small c={c} text={countLabel(label, count)} label={`Show ${label.toLowerCase()} for ${name}`}
    selected={section === key} onPress={() => setSection(key)} />;

  const workList = <View accessibilityLabel="Lane work" style={{ gap: space.xs }}>
    {tasks.error && <View accessibilityRole="alert" style={{ gap: space.xxs }}>
      <Text style={{ ...text, color: r.warning }}>{tasks.items ? `Showing the last work page. It may be out of date: ${tasks.error}` : `Couldn’t load work: ${tasks.error}`}</Text>
      {onRetryTasks && <Button small c={c} text="Retry" label="Retry loading lane tasks" onPress={onRetryTasks} />}
    </View>}
    {tasks.items === undefined && !tasks.error && <Text style={meta}>Loading work…</Text>}
    {tasks.items && workTotal > tasks.items.length && <Text style={meta}>Showing {tasks.items.length ? (tasks.offset ?? 0) + 1 : 0}–{(tasks.offset ?? 0) + tasks.items.length} of {workTotal} live tasks.</Text>}
    {(tasks.offset ?? 0) > 0 && onLoadPreviousTasks && <View style={row}><Button small c={c} text="Previous tasks" label="Load previous page of lane tasks" onPress={onLoadPreviousTasks} />{tasks.nextOffset != null && onLoadMoreTasks && <Button small c={c} text="Next tasks" label="Load next page of lane tasks" onPress={() => onLoadMoreTasks(tasks.nextOffset!)} />}</View>}
    {(tasks.offset ?? 0) === 0 && tasks.nextOffset != null && onLoadMoreTasks && <View style={row}><Button small c={c} text="Next tasks" label="Load next page of lane tasks" onPress={() => onLoadMoreTasks(tasks.nextOffset!)} /></View>}
    {tasks.items?.map(task => {
      const signal = task.held ? `Held${task.hold?.reason ? ` · ${task.hold.reason}` : ""}` : task.waitState?.nextAction ?? (task.waitState ? `Waiting · ${task.waitState.owner}` : null);
      return <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={`Open task ${task.title}, ${phaseStateLabel(task)}${signal ? `, ${signal}` : ""}`} onPress={() => onOpenTask(task.id)}
      style={{ gap: 2, padding: space.xs, borderRadius: radius.card, borderWidth: 1, borderColor: r.border, backgroundColor: r.section }}>
      <Text numberOfLines={2} style={{ ...text, fontWeight: "600" }}>{task.title}</Text>
      <Text style={meta}>{phaseStateLabel(task)}{signal ? ` · ${signal}` : ""}</Text>
    </Pressable>})}
    {tasks.items && !tasks.items.length && workTotal === 0 && <Text style={meta}>{lane.terminalCount ? "No live work in this lane." : "No work in this lane."}</Text>}
    {(tasks.offset ?? 0) > 0 && onLoadPreviousTasks && <View style={row}><Button small c={c} text="Previous tasks" label="Load previous page of lane tasks" onPress={onLoadPreviousTasks} />{tasks.nextOffset != null && onLoadMoreTasks && <Button small c={c} text="Next tasks" label="Load next page of lane tasks" onPress={() => onLoadMoreTasks(tasks.nextOffset!)} />}</View>}
    {(tasks.offset ?? 0) === 0 && tasks.nextOffset != null && onLoadMoreTasks && <View style={row}><Button small c={c} text="Next tasks" label="Load next page of lane tasks" onPress={() => onLoadMoreTasks(tasks.nextOffset!)} /></View>}
    <View style={{ gap: space.xxs, borderTopWidth: 1, borderTopColor: r.border, paddingTop: space.xs }}>
      <Text style={{ ...text, fontWeight: "600" }}>Finished · {lane.terminalCount}</Text>
      {lane.recentOutcomes.map(outcome => <View key={outcome.taskId} style={{ gap: 2 }}>
        <Text style={text}>{outcome.title} · {outcome.outcome}</Text>
        <Text selectable style={meta}>{outcome.prNumber ? `PR #${outcome.prNumber}` : outcome.prUrl ?? "No pull request"}{outcome.finishedAt ? ` · ${formatLocalDateTime(outcome.finishedAt)}` : ""}</Text>
      </View>)}
      {lane.recentOutcomes.length < lane.terminalCount && <Text style={meta}>The last {lane.recentOutcomes.length} of {lane.terminalCount} finished.</Text>}
      {!lane.terminalCount && <Text style={meta}>No finished work yet.</Text>}
    </View>
  </View>;

  const documentBody = () => {
    const current = doc.data;
    if (current === undefined && !doc.error) return <Text style={meta}>Loading document…</Text>;
    if (current === undefined) return <View accessibilityRole="alert" style={{ ...alertPanel, borderColor: r.danger }}>
      <Text style={text}>Couldn’t load the lane document: {doc.error}</Text>
      <Text style={meta}>No version is shown until it loads.</Text>
      <View style={row}><Button small c={c} text="Retry document" label={`Retry the ${name} document`} onPress={onRetryDocument} /></View>
    </View>;
    if (current === null) return <View style={{ gap: space.xs }}>
      {doc.error && <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>Refreshing failed: {doc.error}</Text>}
      <Text style={text}>No lane document yet.</Text>
      {canEdit && <View style={row}><Button small c={c} text="Write document" label={`Write document for ${name}`} disabled={busy} onPress={startEdit} /></View>}
    </View>;
    const preview = lanePreview(current.text);
    return <View style={{ gap: space.xs }}>
      {doc.error && <View accessibilityRole="alert" style={alertPanel}>
        <Text style={{ ...text, color: r.warning }}>Showing version {current.version}. The latest could not be refreshed: {doc.error}. It may be out of date.</Text>
        <View style={row}><Button small c={c} text="Retry refresh" label={`Retry refreshing the ${name} document`} onPress={onRetryDocument} /></View>
      </View>}
      <View accessibilityLabel="Lane document preview"><Readable text={preview.text} c={c} /></View>
      {preview.truncated && <Text style={meta}>Preview only.</Text>}
      {Boolean(draft) && <Text accessibilityRole="alert" style={{ ...meta, color: r.warning }}>You have unsaved changes to this document. Edit to save or discard them.</Text>}
      <View style={row}>
        <Button small c={c} text="Read full document" label={`Read full document for ${name}`} onPress={() => setMode("read")} />
        {canEdit && <Button small c={c} text={draft ? "Continue editing" : "Edit"} label={`${draft ? "Continue editing" : "Edit"} the ${name} document`} disabled={busy} onPress={startEdit} />}
      </View>
    </View>;
  };

  const documentPreview = <View accessibilityLabel="Lane document" style={{ gap: space.xs }}>
    <View style={{ ...row, justifyContent: "space-between" }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Document{latest ? ` · version ${latest.version}` : ""}</Text>
      {latest && <Text style={meta}>{latest.author} · {formatLocalDateTime(latest.createdAt)}</Text>}
    </View>
    <View style={panel}>{documentBody()}</View>
  </View>;

  const pastDocument = () => {
    if (past === null) return <Text style={meta}>Loading version {pastVersion}…</Text>;
    if (past.error) return <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>Couldn’t load version {past.version}: {past.error}</Text>;
    if (past.document === undefined) return <Text style={meta}>Loading version {past.version}…</Text>;
    if (past.document === null) return <Text style={text}>Version {past.version} is not stored.</Text>;
    return <View style={{ gap: space.xs }}>
      <Text style={meta}>Version {past.version} · {past.document.author} · {formatLocalDateTime(past.document.createdAt)} · not the latest</Text>
      <Readable text={past.document.text} c={c} />
    </View>;
  };

  const fullRead = <View accessibilityLabel="Lane document, full text" style={{ gap: space.sm }}>
    <View style={row}><Button small c={c} text="Back to lane" label={`Back to lane ${name}`} onPress={back} /></View>
    <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>{name} · document{latest ? ` · version ${pastVersion ?? latest.version}` : ""}</Text>
    {doc.error && <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>The latest could not be refreshed: {doc.error}. It may be out of date.</Text>}
    {latest === null && <Text style={text}>No lane document yet.</Text>}
    {latest && pastVersion === null && <Readable text={latest.text} c={c} />}
    {latest && pastVersion !== null && pastDocument()}
    {latest && latest.version > 1 && <View style={row}>
      <Button small c={c} text="Earlier version" label={`Show the earlier version of ${name}`} disabled={(pastVersion ?? latestVersion) <= 1} onPress={() => setPastVersion((pastVersion ?? latestVersion) - 1)} />
      <Button small c={c} text="Later version" label={`Show the later version of ${name}`} disabled={pastVersion === null} onPress={() => setPastVersion(pastVersion! + 1 >= latestVersion ? null : pastVersion! + 1)} />
      <Button small c={c} text="Latest version" label={`Show the latest version of ${name}`} disabled={pastVersion === null} onPress={() => setPastVersion(null)} />
    </View>}
    {canEdit && latest !== undefined && pastVersion === null && <View style={row}><Button small c={c} text={draft ? "Continue editing" : "Edit"} label={`${draft ? "Continue editing" : "Edit"} the ${name} document`} disabled={busy} onPress={startEdit} /></View>}
  </View>;

  const editor = draft && <View accessibilityLabel="Lane document editor" style={{ gap: space.sm }}>
    <View style={row}><Button small c={c} text="Cancel" label={`Cancel changes to the ${name} document`} disabled={saving} onPress={discard} /></View>
    <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>
      {draft.base === 0 ? `Write the first version of ${name}` : `Editing ${name} from version ${draft.base}`}
    </Text>
    {conflict && latest && <View accessibilityRole="alert" accessibilityLabel="Lane document changed" style={alertPanel}>
      <Text style={{ ...text, fontWeight: "600" }}>The document changed to version {latest.version} while you were editing</Text>
      <Text style={meta}>Your text is kept, and nothing is saved until you choose a base. Latest version, for comparison:</Text>
      <Text selectable style={{ ...text, color: r.muted }}>{lanePreview(latest.text).text}</Text>
      <View style={row}>
        <Button small c={c} text={`Use version ${latest.version} as base`} label={`Use version ${latest.version} of ${name} as the base for my text`} disabled={saving}
          onPress={() => onDraft({ base: latest.version, text: draft.text, start: latest.text })} />
        <Button small c={c} text="Discard my text" label={`Discard my text for ${name} and keep the latest`} disabled={saving} onPress={discard} />
      </View>
    </View>}
    <TextInput accessibilityLabel="Lane document text" multiline editable={!saving} value={draft.text} onChangeText={value => onDraft({ ...draft, text: value })}
      autoCapitalize="none" autoCorrect={false}
      style={{ minHeight: 240, textAlignVertical: "top", color: r.foreground, backgroundColor: r.section, borderColor: r.border, borderWidth: 1, borderRadius: radius.control, padding: space.sm,
        fontSize: type.section.fontSize, lineHeight: type.section.lineHeight }} />
    {saveError && <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>Not saved: {saveError}. Your text is kept.</Text>}
    <Text style={meta}>Saving adds the text as a new version. It is not a plan change and grants no dispatch authority.</Text>
    <View style={row}>
      <Button small c={c} text={saving ? "Saving…" : "Save document"} label={`Save the ${name} document`} disabled={busy || saving || Boolean(saveBlock)} hint={saveBlock || undefined} onPress={save} />
    </View>
    {saveBlock && <Text style={meta}>{saveBlock}</Text>}
  </View>;

  return <View accessibilityLabel={`Lane ${name}`} style={{ gap: space.md }}>
    <View style={{ gap: space.xxs }}>
      <Text style={meta}>Lane · {statusWord[lane.status]}</Text>
      <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" }}>{name}</Text>
      {Boolean(lane.aim) && <Text selectable style={text}>{lane.aim}</Text>}
    </View>
    {shown === "preview" && <>
      <LaneProjects lane={lane} projects={projects} plans={plans} selected={selected} busy={busy} onSelectProject={onSelectProject} c={c} />
      <View accessibilityLabel="Lane document and records" style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: space.md, alignItems: "flex-start" }}>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: compact ? "100%" : 260, maxWidth: "100%" }}>{documentPreview}</View>
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: compact ? "100%" : 260, maxWidth: "100%", gap: space.xs }}>
          <View style={row}>
            {segment("work", "Work", liveTotal)}
            {segment("leads", "Leads", leadItems?.length)}
            {segment("papercuts", "Papercuts", cutItems?.length)}
          </View>
          <View style={panel}>
            {section === "work" && workList}
            {section === "leads" && <RecordList read={leadRead} label="leads" empty="No open leads in this lane." describe={lead => lead.preview.slice(0, 120)}
              shown={listShown.leads} onShowMore={() => setListShown(value => ({ ...value, leads: value.leads + LANE_LIST_PAGE }))}
              onOpen={lead => onOpenLead(lead)} onRetry={onRetryLeads} c={c} />}
            {section === "papercuts" && <RecordList read={cutRead} label="papercuts" empty="No open papercuts in this lane." describe={lead => lead.papercutArea ?? "Papercut"}
              shown={listShown.papercuts} onShowMore={() => setListShown(value => ({ ...value, papercuts: value.papercuts + LANE_LIST_PAGE }))}
              onOpen={lead => onOpenLead(lead)} onRetry={onRetryLeads} c={c} />}
          </View>
        </View>
      </View>
    </>}
    {shown === "read" && fullRead}
    {shown === "edit" && editor}
    <View style={{ gap: space.xs, borderTopWidth: 1, borderTopColor: r.border, paddingTop: space.xs }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${details ? "Hide" : "Show"} details for ${name}`} accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)}>
        <Text style={{ ...text, fontWeight: "600" }}>{details ? "▾" : "▸"} Details</Text>
      </Pressable>
      {details && <View accessibilityLabel={`Lane details for ${name}`} style={{ gap: space.xs }}>
        <Text selectable style={meta}>Key · {lane.key}</Text>
        <Text selectable accessibilityLabel="Lane repositories" style={meta}>Repositories · {lane.repositories.map(repo => `${repo.origin} (${repo.path})`).join(", ") || "none"}</Text>
        {Boolean(lane.note) && <Text selectable style={text}>Note · {lane.note}</Text>}
        {onSetStatus && <View style={row}>
          {(["active", "paused", "done", "abandoned"] as const).filter(status => status !== lane.status).map(status => <Button key={status} small c={c}
            text={statusWord[status]} label={`Set lane ${lane.key} ${status}`} disabled={busy} onPress={() => onSetStatus(status)} />)}
        </View>}
      </View>}
    </View>
  </View>;
}
