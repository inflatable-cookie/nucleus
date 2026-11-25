import { errorText as message } from "./error-text";
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type {
  BoardLead,
  LaneDocumentVersion,
  LaneView,
  Project,
  ProjectPlan,
  TaskSummary,
} from "../shared/contracts";
import { formatLocalDateTime } from "../shared/date-time";
import { phaseStateLabel } from "../shared/task-state";
import { decisionAge } from "../shared/pipeline-board";
import { lanePlaces } from "../shared/lane-finder";
import {
  horizonTitle,
  laneAttention,
  laneDocumentName,
  laneOpen,
  lanePlanContext,
} from "../shared/planning-read";
import {
  ActionButton,
  Button,
  row,
  useCardFill,
  type Colors,
} from "./controls";
import { MarkDoneConfirm, ReopenHelp } from "./lane-mark-done";
import {
  planningRead,
  radius,
  roles,
  space,
  toneWash,
  type,
} from "./design";
import {
  BoardCard,
  BoardCardVariantContext,
  phaseTone,
  rowPhaseWords,
  type CardKind,
} from "./board/cards";
import { Pill } from "./planning-roadmap";
import { Readable } from "./readable-text";

/** The latest document as read. `null` is a lane with no document yet; `undefined` is not loaded. */
export type LaneDocumentRead = {
  data?: LaneDocumentVersion | null;
  error?: string;
};
/** A list as read. `items` is undefined until the first read completes, so loading never looks like an empty list. */
export type LaneListRead<T> = {
  items?: T[];
  error?: string;
  total?: number;
  offset?: number;
  nextOffset?: number | null;
};
/**
 * Unsaved document text. It lives above the screen so it survives leaving the Planning tab. `base` is the
 * version the text was written against and `start` is that version's text, so an unchanged draft is not saved.
 */
export type LaneDraft = { base: number; text: string; start: string };

type Mode = "preview" | "read" | "edit";

export const LANE_PREVIEW_LINES = 8;
export const LANE_PREVIEW_CHARS = 600;

/** The opening of a document for the lane's preview. `truncated` says there is more to read in full. */
export function lanePreview(text: string): {
  text: string;
  truncated: boolean;
} {
  const lines = text.split("\n");
  const truncated =
    lines.length > LANE_PREVIEW_LINES || text.length > LANE_PREVIEW_CHARS;
  return {
    text: truncated
      ? lines
          .slice(0, LANE_PREVIEW_LINES)
          .join("\n")
          .slice(0, LANE_PREVIEW_CHARS)
      : text,
    truncated,
  };
}

/** Papercuts are leads tagged `papercut`; the lane screen lists them apart from other leads. */
export const isPapercut = (lead: Pick<BoardLead, "tags">) =>
  lead.tags.includes("papercut");
/** Live tasks across every phase. The server computes these from the whole lane, so the total is complete. */
export const liveTaskCount = (lane: Pick<LaneView, "liveByPhase">) =>
  Object.values(lane.liveByPhase).reduce((sum, count) => sum + count, 0);

const statusWord: Record<LaneView["status"], string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  abandoned: "Abandoned",
};

/**
 * Lead and papercut lists show one page of eight at a time. The caller's read is complete,
 * so the count and the "showing N of M" line are true totals, never a first page dressed as one.
 */
export const LANE_LIST_PAGE = 8;
/** Recently finished shows this many until See all. */
export const LANE_FINISHED_PREVIEW = 5;

/** One related list: loading, failed, empty and loaded are distinct, and a failed read never shows a count. */
function RecordList({
  read,
  kind,
  label,
  empty,
  describe,
  shown,
  onShowMore,
  onOpen,
  onRetry,
  c,
}: {
  read: LaneListRead<BoardLead>;
  kind: CardKind;
  label: string;
  empty: string;
  describe: (lead: BoardLead) => string;
  shown: number;
  onShowMore: () => void;
  onOpen: (lead: BoardLead) => void;
  onRetry?: () => void;
  c: Colors;
}) {
  const r = roles(c);
  const meta = {
    color: r.muted,
    fontSize: type.metadata.fontSize,
    lineHeight: type.metadata.lineHeight,
  };
  const retry = onRetry && (
    <View style={row}>
      <Button
        small
        c={c}
        text="Retry"
        label={`Retry loading ${label}`}
        onPress={onRetry}
      />
    </View>
  );
  if (read.items === undefined)
    return read.error ? (
      <View
        accessibilityRole="alert"
        style={{
          gap: space.xs,
          padding: space.sm,
          borderRadius: radius.control,
          backgroundColor: toneWash(r.danger, r.section),
        }}
      >
        <Text style={{ color: r.foreground }}>
          Couldn’t load {label}: {read.error}
        </Text>
        <Text style={meta}>Nothing here is a total until it loads.</Text>
        {retry}
      </View>
    ) : (
      <Text style={meta}>Loading {label}…</Text>
    );
  return (
    <View style={{ gap: space.xs }}>
      {read.error && (
        <View accessibilityRole="alert" style={{ gap: space.xxs }}>
          <Text
            style={{
              color: r.warning,
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
            }}
          >
            Showing the last {label} read. It may be out of date: {read.error}
          </Text>
          {retry}
        </View>
      )}
      {!read.items.length && Boolean(empty) && (
        <Text style={meta}>{empty}</Text>
      )}
      {read.items.length > shown && (
        <Text style={meta}>
          Showing {shown} of {read.items.length} {label}.
        </Text>
      )}
      {read.items.slice(0, shown).map((lead) => (
        <BoardCard
          key={lead.id}
          label={`Open ${label.replace(/s$/, "")} ${lead.title}`}
          onPress={() => onOpen(lead)}
          selected={false}
          kind={kind}
          title={lead.title}
          status={{ tone: "muted", state: describe(lead) || "Open" }}
          c={c}
        />
      ))}
      {read.items.length > shown && (
        <View style={row}>
          <Button
            small
            c={c}
            text={`Show ${Math.min(LANE_LIST_PAGE, read.items.length - shown)} more ${label}`}
            onPress={onShowMore}
          />
        </View>
      )}
    </View>
  );
}

/**
 * The lane page (nucleus#867, redesigned in nucleus#1531): the title with its horizon,
 * open state and other plans; the aim in full; the finish line and why it is still open;
 * the plan's latest status note; what is in flight, waiting to start and recently
 * finished. A side column holds the document, the counts at a glance and the plans it is
 * in. Counts appear only where the read is complete; loading, failed and stale reads say
 * so. The key, repositories and status actions sit behind Details.
 *
 * Wide puts the side column beside the sections; narrow stacks them. Reading and editing
 * the document take the whole lane column, with Back to the lane beside them.
 */
export function LaneScreen({
  lane,
  project = null,
  compact,
  projects,
  plans,
  busy,
  canEdit,
  doc,
  draft,
  onDraft,
  onSaveDocument,
  onRetryDocument,
  readVersion,
  tasks,
  leads,
  onOpenTask,
  onOpenLead,
  onRetryLeads,
  onLoadMoreTasks,
  onLoadPreviousTasks,
  onRetryTasks,
  onSelectProject,
  onSetStatus,
  readFinished,
  c,
}: {
  lane: LaneView;
  /** The plan the lane was opened from: its horizon, note and finish line show. */
  project?: string | null;
  compact: boolean;
  projects: Project[];
  plans: ProjectPlan[];
  busy: boolean;
  /** Whether the operator may write the lane document. */
  canEdit: boolean;
  doc: LaneDocumentRead;
  draft: LaneDraft | null;
  onDraft: (draft: LaneDraft | null) => void;
  /** Saves `text` as the next version after `version`. Rejects when the save is refused; the draft is kept. */
  onSaveDocument: (input: { version: number; text: string }) => Promise<void>;
  onRetryDocument: () => void;
  readVersion: (version: number) => Promise<LaneDocumentVersion | null>;
  tasks: LaneListRead<TaskSummary> & { rows?: React.ReactNode };
  leads: LaneListRead<BoardLead>;
  onOpenTask: (id: string) => void;
  onOpenLead: (lead: BoardLead) => void;
  onRetryLeads?: () => void;
  onLoadMoreTasks?: (offset: number) => void;
  onLoadPreviousTasks?: () => void;
  onRetryTasks?: () => void;
  onSelectProject?: (key: string) => void;
  onSetStatus?: (status: "active" | "done" | "abandoned", note?: string) => void;
  /** One page of the lane's finished work, newest first (`queue.outcome-search` by lane). */
  readFinished?: (cursor: string | null) => Promise<{
    results: Array<
      Pick<
        LaneView["recentOutcomes"][number],
        "taskId" | "title" | "outcome" | "prNumber" | "prUrl" | "finishedAt"
      >
    >;
    cursor: string | null;
  }>;
  c: Colors;
}) {
  const r = roles(c);
  // Cards step up from the pane: the section on the canvas, raised in a dialog.
  const fill = useCardFill(c);
  const [mode, setMode] = useState<Mode>(draft ? "edit" : "preview");
  const [pastVersion, setPastVersion] = useState<number | null>(null);
  const [past, setPast] = useState<{
    version: number;
    document?: LaneDocumentVersion | null;
    error?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [details, setDetails] = useState(false);
  // Marking the lane done always asks first (nucleus#1536); closing the dialog cancels.
  const [closing, setClosing] = useState<"done" | "abandoned" | null>(null);
  // See all's read of the lane's finished work: the rows so far and the next page's cursor.
  const [allFinished, setAllFinished] = useState<{
    rows: Array<
      Pick<
        LaneView["recentOutcomes"][number],
        "taskId" | "title" | "outcome" | "prNumber" | "prUrl" | "finishedAt"
      >
    >;
    cursor: string | null;
    loading?: boolean;
    error?: string;
  } | null>(null);
  const [width, setWidth] = useState(0);
  // Lead and papercut lists page eight at a time from the lane's complete read.
  const [listShown, setListShown] = useState<{
    leads: number;
    papercuts: number;
  }>({ leads: LANE_LIST_PAGE, papercuts: LANE_LIST_PAGE });
  const latest = doc.data;
  const latestVersion = latest?.version ?? 0;
  const loaded = doc.data !== undefined;
  const name = lane.title;
  const text = {
    color: r.foreground,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  } as const;
  const meta = {
    color: r.muted,
    fontSize: type.metadata.fontSize,
    lineHeight: type.metadata.lineHeight,
  } as const;
  const alertPanel = {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.control,
    backgroundColor: toneWash(r.warning, fill),
  } as const;
  // Edit mode without a draft has nothing to edit; the screen shows the document instead.
  const shown: Mode = mode === "edit" && !draft ? "preview" : mode;
  // The draft is based on an older version than the latest: saving it now would overwrite newer text.
  const conflict = Boolean(draft && loaded && latestVersion !== draft.base);
  const unchanged = Boolean(
    draft && draft.text === draft.start && draft.base === latestVersion,
  );
  const saveBlock = !draft
    ? ""
    : conflict
      ? "The document changed. Use the latest version as the base first."
      : unchanged
        ? "No changes to save."
        : "";

  // A version read for history. Only the one the operator is looking at is fetched.
  useEffect(() => {
    if (pastVersion === null) {
      setPast(null);
      return;
    }
    let live = true;
    setPast(null);
    readVersion(pastVersion).then(
      (found) => {
        if (live) setPast({ version: pastVersion, document: found });
      },
      (error) => {
        if (live) setPast({ version: pastVersion, error: message(error) });
      },
    );
    return () => {
      live = false;
    };
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
    if (!draft)
      onDraft({
        base: latestVersion,
        text: latest?.text ?? "",
        start: latest?.text ?? "",
      });
    setSaveError("");
    setMode("edit");
  };
  const discard = () => {
    onDraft(null);
    setSaveError("");
    setMode("preview");
    setPastVersion(null);
  };
  const back = () => {
    setMode("preview");
    setPastVersion(null);
  };

  const liveTotal = liveTaskCount(lane);
  const attention = laneAttention(lane);
  const workTotal = tasks.total ?? liveTotal;
  const leadItems = leads.items?.filter((lead) => !isPapercut(lead));
  const cutItems = leads.items?.filter(isPapercut);
  const leadRead = { items: leadItems, error: leads.error };
  const cutRead = { items: cutItems, error: leads.error };
  const context = lanePlanContext(lane.key, plans, project);
  const places = lanePlaces(lane, projects, plans);
  const others = places.filter(
    (place) => place.key !== context?.project && place.horizon,
  );
  const open = laneOpen(lane);
  const side = width === 0 ? !compact : width >= planningRead.sideMin;
  const sectionTitle = (title: string, detail?: React.ReactNode) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: space.xs,
      }}
    >
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>
        {title}
      </Text>
      {detail}
    </View>
  );
  const box = {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.panel,
    backgroundColor: fill,
  } as const;
  const pager = (
    <>
      {(tasks.offset ?? 0) > 0 && onLoadPreviousTasks && (
        <View style={row}>
          <Button
            small
            c={c}
            text="Previous tasks"
            label="Load previous page of lane tasks"
            onPress={onLoadPreviousTasks}
          />
          {tasks.nextOffset != null && onLoadMoreTasks && (
            <Button
              small
              c={c}
              text="Next tasks"
              label="Load next page of lane tasks"
              onPress={() => onLoadMoreTasks(tasks.nextOffset!)}
            />
          )}
        </View>
      )}
      {(tasks.offset ?? 0) === 0 &&
        tasks.nextOffset != null &&
        onLoadMoreTasks && (
          <View style={row}>
            <Button
              small
              c={c}
              text="Next tasks"
              label="Load next page of lane tasks"
              onPress={() => onLoadMoreTasks(tasks.nextOffset!)}
            />
          </View>
        )}
    </>
  );

  const inFlight = (
    <View accessibilityLabel="In flight" style={{ gap: space.xs }}>
      {sectionTitle(
        "In flight",
        <Text style={meta}>
          {workTotal} {workTotal === 1 ? "task" : "tasks"}
        </Text>,
      )}
      {tasks.error && (
        <View accessibilityRole="alert" style={{ gap: space.xxs }}>
          <Text style={{ ...text, color: r.warning }}>
            {tasks.items
              ? `Showing the last work page. It may be out of date: ${tasks.error}`
              : `Couldn’t load work: ${tasks.error}`}
          </Text>
          {onRetryTasks && (
            <View style={row}>
              <Button
                small
                c={c}
                text="Retry"
                label="Retry loading lane tasks"
                onPress={onRetryTasks}
              />
            </View>
          )}
        </View>
      )}
      {tasks.rows === undefined && tasks.items === undefined && !tasks.error && (
        <Text style={meta}>Loading work…</Text>
      )}
      {tasks.items && workTotal > tasks.items.length && (
        <Text style={meta}>
          Showing {tasks.items.length ? (tasks.offset ?? 0) + 1 : 0}–
          {(tasks.offset ?? 0) + tasks.items.length} of {workTotal} live tasks.
        </Text>
      )}
      <BoardCardVariantContext.Provider value="row">
        <View style={{ marginHorizontal: -space.xs }}>
          {tasks.rows ?? tasks.items?.map((task) => {
            const signal = task.held
              ? `Held${task.hold?.reason ? ` · ${task.hold.reason}` : ""}`
              : (task.waitState?.nextAction ??
                (task.waitState ? `Waiting · ${task.waitState.owner}` : null));
            return (
              <BoardCard
                key={task.id}
                label={`Open task ${task.title}, ${phaseStateLabel(task)}${signal ? `, ${signal}` : ""}`}
                onPress={() => onOpenTask(task.id)}
                selected={false}
                kind="task"
                meta={task.reference ?? null}
                title={task.title}
                status={{
                  tone: phaseTone(task),
                  state: rowPhaseWords(task),
                  // The inbox row's detail: the wait or hold, else the latest report, else the stored reason.
                  detail: signal ?? (task.headline || task.reason || null),
                }}
                c={c}
              />
            );
          })}
        </View>
      </BoardCardVariantContext.Provider>
      {(tasks.total === 0 || tasks.items?.length === 0) && workTotal === 0 && (
        <View style={{ ...box, alignItems: "center" }}>
          <Text style={meta}>No tasks running in this lane</Text>
        </View>
      )}
      {pager}
    </View>
  );

  const nothingWaiting = Boolean(
    leadItems && cutItems && !leadItems.length && !cutItems.length,
  );
  const waiting = (
    <View accessibilityLabel="Waiting to start" style={{ gap: space.xs }}>
      {sectionTitle(
        "Waiting to start",
        <Text style={meta}>leads and papercuts</Text>,
      )}
      {nothingWaiting ? (
        <View style={{ ...box, alignItems: "center" }}>
          <Text style={meta}>Nothing waiting</Text>
        </View>
      ) : (
        <BoardCardVariantContext.Provider value="row">
          <View style={{ gap: space.xs, marginHorizontal: -space.xs }}>
            {(leadItems === undefined || leadItems.length > 0) && (
              <RecordList
                read={leadRead}
                kind="lead"
                label="leads"
                empty=""
                describe={(lead) => lead.preview.slice(0, 120)}
                shown={listShown.leads}
                onShowMore={() =>
                  setListShown((value) => ({
                    ...value,
                    leads: value.leads + LANE_LIST_PAGE,
                  }))
                }
                onOpen={(lead) => onOpenLead(lead)}
                onRetry={onRetryLeads}
                c={c}
              />
            )}
            {cutItems !== undefined && cutItems.length > 0 && (
              <RecordList
                read={cutRead}
                kind="papercut"
                label="papercuts"
                empty=""
                describe={(lead) => lead.papercutArea ?? "Papercut"}
                shown={listShown.papercuts}
                onShowMore={() =>
                  setListShown((value) => ({
                    ...value,
                    papercuts: value.papercuts + LANE_LIST_PAGE,
                  }))
                }
                onOpen={(lead) => onOpenLead(lead)}
                onRetry={onRetryLeads}
                c={c}
              />
            )}
          </View>
        </BoardCardVariantContext.Provider>
      )}
    </View>
  );

  // See all reads the lane's whole outcome history through the outcome search, a page at a time;
  // the lane view itself carries only its latest ten.
  type FinishedRow = Pick<
    LaneView["recentOutcomes"][number],
    "taskId" | "title" | "outcome" | "prNumber" | "prUrl" | "finishedAt"
  >;
  const seeAll = async (cursor: string | null) => {
    if (!readFinished) {
      setAllFinished({ rows: lane.recentOutcomes, cursor: null });
      return;
    }
    setAllFinished((current) => ({
      rows: current?.rows ?? [],
      cursor: current?.cursor ?? null,
      loading: true,
    }));
    try {
      const page = await readFinished(cursor);
      setAllFinished((current) => ({
        rows: [...(cursor ? (current?.rows ?? []) : []), ...page.results],
        cursor: page.cursor,
      }));
    } catch (error) {
      setAllFinished((current) => ({
        rows: current?.rows ?? [],
        cursor,
        error: message(error),
      }));
    }
  };
  const finishedShown: FinishedRow[] = allFinished
    ? allFinished.rows
    : lane.recentOutcomes.slice(0, LANE_FINISHED_PREVIEW);
  const moreFinished =
    !allFinished &&
    (lane.recentOutcomes.length > LANE_FINISHED_PREVIEW ||
      lane.terminalCount > finishedShown.length);
  const finished = (
    <View accessibilityLabel="Recently finished" style={{ gap: space.xs }}>
      {sectionTitle(
        "Recently finished",
        <View style={{ flexDirection: "row", gap: space.xxs }}>
          <Text style={meta}>
            {lane.terminalCount.toLocaleString()} in total
          </Text>
          {moreFinished && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`See all finished work in ${name}`}
              onPress={() => void seeAll(null)}
            >
              <Text style={{ ...meta, color: r.accent }}>· See all</Text>
            </Pressable>
          )}
        </View>,
      )}
      <View
        style={{
          gap: space.xs,
          paddingLeft: space.sm,
        }}
      >
        {finishedShown.map((outcome) => (
          <View key={outcome.taskId} style={{ gap: space.xxs / 2 }}>
            <Text style={text}>
              {outcome.outcome === "done" ? "✓ " : "✕ "}
              {outcome.title}
            </Text>
            <Text selectable style={meta}>
              {outcome.outcome === "done"
                ? ""
                : `${outcome.outcome === "cancelled" ? "Cancelled" : "Superseded"} · `}
              {outcome.prNumber
                ? `PR #${outcome.prNumber}`
                : (outcome.prUrl ?? "No pull request")}
              {outcome.finishedAt
                ? ` · ${formatLocalDateTime(outcome.finishedAt)}`
                : ""}
            </Text>
          </View>
        ))}
        {!lane.terminalCount && <Text style={meta}>Nothing finished yet.</Text>}
        {allFinished?.loading && (
          <Text style={meta}>Loading finished work…</Text>
        )}
        {allFinished?.error && (
          <View accessibilityRole="alert" style={{ gap: space.xxs }}>
            <Text style={{ ...meta, color: r.warning }}>
              Couldn’t load finished work: {allFinished.error}
            </Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Retry"
                label={`Retry loading finished work in ${name}`}
                onPress={() => void seeAll(allFinished.cursor)}
              />
            </View>
          </View>
        )}
        {allFinished &&
          !allFinished.loading &&
          !allFinished.error &&
          allFinished.cursor && (
            <View style={row}>
              <Button
                small
                c={c}
                text="Show more finished work"
                label={`Show more finished work in ${name}`}
                onPress={() => void seeAll(allFinished.cursor)}
              />
            </View>
          )}
        {allFinished &&
          !readFinished &&
          allFinished.rows.length < lane.terminalCount && (
            <Text style={meta}>
              The last {allFinished.rows.length} of {lane.terminalCount}{" "}
              finished.
            </Text>
          )}
      </View>
    </View>
  );

  const documentBox = () => {
    const current = doc.data;
    const heading = (
      <Text style={{ ...text, fontWeight: "600" }}>Document</Text>
    );
    if (current === undefined && !doc.error)
      return (
        <View style={box}>
          {heading}
          <Text style={meta}>Loading document…</Text>
        </View>
      );
    if (current === undefined)
      return (
        <View
          accessibilityRole="alert"
          style={{ ...box, backgroundColor: toneWash(r.danger, fill) }}
        >
          {heading}
          <Text style={text}>Couldn’t load the lane document: {doc.error}</Text>
          <Text style={meta}>No version is shown until it loads.</Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Retry document"
              label={`Retry the ${name} document`}
              onPress={onRetryDocument}
            />
          </View>
        </View>
      );
    return (
      <View accessibilityLabel="Lane document" style={box}>
        {heading}
        {doc.error && (
          <View accessibilityRole="alert" style={{ gap: space.xxs }}>
            <Text style={{ ...meta, color: r.warning }}>
              {current
                ? `Showing version ${current.version}. The latest could not be refreshed: ${doc.error}. It may be out of date.`
                : `Refreshing failed: ${doc.error}`}
            </Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Retry refresh"
                label={`Retry refreshing the ${name} document`}
                onPress={onRetryDocument}
              />
            </View>
          </View>
        )}
        {current ? (
          <>
            <Text style={{ ...text, color: r.muted }}>
              {laneDocumentName(current.text)}
            </Text>
            <Text style={meta}>
              Version {current.version} · edited{" "}
              {decisionAge(current.createdAt)}
            </Text>
            {Boolean(draft) && (
              <Text
                accessibilityRole="alert"
                style={{ ...meta, color: r.warning }}
              >
                You have unsaved changes to this document. Edit lane to save or
                discard them.
              </Text>
            )}
            <View style={row}>
              <Button
                small
                c={c}
                text="Open document"
                label={`Read full document for ${name}`}
                onPress={() => setMode("read")}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={meta}>No lane document yet.</Text>
            {canEdit && (
              <View style={row}>
                <Button
                  small
                  c={c}
                  text="Write document"
                  label={`Write document for ${name}`}
                  disabled={busy}
                  onPress={startEdit}
                />
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  const glance = (label: string, value: string) => (
    <View
      key={label}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: space.xs,
      }}
    >
      <Text style={{ ...text, color: r.muted }}>{label}</Text>
      <Text style={{ ...text, fontWeight: "500" }}>{value}</Text>
    </View>
  );
  const atAGlance = (
    <View accessibilityLabel="At a glance" style={box}>
      <Text style={{ ...text, fontWeight: "600" }}>At a glance</Text>
      {glance("Live tasks", String(liveTotal))}
      {attention > 0 && glance("Need you", String(attention))}
      {glance("Finished", lane.terminalCount.toLocaleString())}
      {glance(
        "Leads waiting",
        leadItems === undefined ? "…" : String(leadItems.length),
      )}
      {glance(
        "Papercuts waiting",
        cutItems === undefined ? "…" : String(cutItems.length),
      )}
      {glance(
        "Last activity",
        lane.lastActivityAt ? decisionAge(lane.lastActivityAt) : "None yet",
      )}
    </View>
  );
  const plansBox = (
    <View accessibilityLabel={`Plans ${name} is in`} style={box}>
      <Text style={{ ...text, fontWeight: "600" }}>Plans it’s in</Text>
      {!places.length && (
        <Text style={meta}>No project lists this lane's repositories yet.</Text>
      )}
      {places.map((place) => {
        const horizon = place.horizon
          ? horizonTitle(place.horizon)
          : "Not in the plan";
        const content = (
          <>
            <Text style={{ ...text, color: r.muted, flexShrink: 1 }}>
              {place.name}
            </Text>
            <Text style={{ ...text, fontWeight: "500" }}>{horizon}</Text>
          </>
        );
        const frame = {
          flexDirection: "row",
          justifyContent: "space-between",
          gap: space.xs,
        } as const;
        return onSelectProject && place.key !== context?.project ? (
          <Pressable
            key={place.key}
            accessibilityRole="button"
            accessibilityLabel={`Show the ${place.name} plan, ${horizon}`}
            disabled={busy}
            onPress={() => onSelectProject(place.key)}
            style={frame}
          >
            {content}
          </Pressable>
        ) : (
          <View
            key={place.key}
            accessible
            accessibilityLabel={`${place.name}: ${horizon}`}
            style={frame}
          >
            {content}
          </View>
        );
      })}
    </View>
  );

  const pastDocument = () => {
    if (past === null)
      return <Text style={meta}>Loading version {pastVersion}…</Text>;
    if (past.error)
      return (
        <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>
          Couldn’t load version {past.version}: {past.error}
        </Text>
      );
    if (past.document === undefined)
      return <Text style={meta}>Loading version {past.version}…</Text>;
    if (past.document === null)
      return <Text style={text}>Version {past.version} is not stored.</Text>;
    return (
      <View style={{ gap: space.xs }}>
        <Text style={meta}>
          Version {past.version} · {past.document.author} ·{" "}
          {formatLocalDateTime(past.document.createdAt)} · not the latest
        </Text>
        <Readable text={past.document.text} c={c} />
      </View>
    );
  };

  const fullRead = (
    <View
      accessibilityLabel="Lane document, full text"
      style={{ gap: space.sm }}
    >
      <View style={row}>
        <Button
          small
          c={c}
          text="Back to lane"
          label={`Back to lane ${name}`}
          onPress={back}
        />
      </View>
      <Text
        accessibilityRole="header"
        style={{
          color: r.foreground,
          fontSize: type.section.fontSize,
          lineHeight: type.section.lineHeight,
          fontWeight: "600",
        }}
      >
        {name} · document
        {latest ? ` · version ${pastVersion ?? latest.version}` : ""}
      </Text>
      {doc.error && (
        <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>
          The latest could not be refreshed: {doc.error}. It may be out of date.
        </Text>
      )}
      {latest === null && <Text style={text}>No lane document yet.</Text>}
      {latest && pastVersion === null && <Readable text={latest.text} c={c} />}
      {latest && pastVersion !== null && pastDocument()}
      {latest && latest.version > 1 && (
        <View style={row}>
          <Button
            small
            c={c}
            text="Earlier version"
            label={`Show the earlier version of ${name}`}
            disabled={(pastVersion ?? latestVersion) <= 1}
            onPress={() => setPastVersion((pastVersion ?? latestVersion) - 1)}
          />
          <Button
            small
            c={c}
            text="Later version"
            label={`Show the later version of ${name}`}
            disabled={pastVersion === null}
            onPress={() =>
              setPastVersion(
                pastVersion! + 1 >= latestVersion ? null : pastVersion! + 1,
              )
            }
          />
          <Button
            small
            c={c}
            text="Latest version"
            label={`Show the latest version of ${name}`}
            disabled={pastVersion === null}
            onPress={() => setPastVersion(null)}
          />
        </View>
      )}
      {canEdit && latest !== undefined && pastVersion === null && (
        <View style={row}>
          <Button
            small
            c={c}
            text={draft ? "Continue editing" : "Edit"}
            label={`${draft ? "Continue editing" : "Edit"} the ${name} document`}
            disabled={busy}
            onPress={startEdit}
          />
        </View>
      )}
    </View>
  );

  const editor = draft && (
    <View accessibilityLabel="Lane document editor" style={{ gap: space.sm }}>
      <View style={row}>
        <Button
          small
          c={c}
          text="Cancel"
          label={`Cancel changes to the ${name} document`}
          disabled={saving}
          onPress={discard}
        />
      </View>
      <Text
        accessibilityRole="header"
        style={{
          color: r.foreground,
          fontSize: type.section.fontSize,
          lineHeight: type.section.lineHeight,
          fontWeight: "600",
        }}
      >
        {draft.base === 0
          ? `Write the first version of ${name}`
          : `Editing ${name} from version ${draft.base}`}
      </Text>
      {conflict && latest && (
        <View
          accessibilityRole="alert"
          accessibilityLabel="Lane document changed"
          style={alertPanel}
        >
          <Text style={{ ...text, fontWeight: "600" }}>
            The document changed to version {latest.version} while you were
            editing
          </Text>
          <Text style={meta}>
            Your text is kept, and nothing is saved until you choose a base.
            Latest version, for comparison:
          </Text>
          <Text selectable style={{ ...text, color: r.muted }}>
            {lanePreview(latest.text).text}
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text={`Use version ${latest.version} as base`}
              label={`Use version ${latest.version} of ${name} as the base for my text`}
              disabled={saving}
              onPress={() =>
                onDraft({
                  base: latest.version,
                  text: draft.text,
                  start: latest.text,
                })
              }
            />
            <Button
              small
              c={c}
              text="Discard my text"
              label={`Discard my text for ${name} and keep the latest`}
              disabled={saving}
              onPress={discard}
            />
          </View>
        </View>
      )}
      <TextInput
        accessibilityLabel="Lane document text"
        multiline
        editable={!saving}
        value={draft.text}
        onChangeText={(value) => onDraft({ ...draft, text: value })}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          minHeight: 240,
          textAlignVertical: "top",
          color: r.foreground,
          backgroundColor: r.section,
          borderColor: r.border,
          borderWidth: 1,
          borderRadius: radius.control,
          padding: space.sm,
          fontSize: type.section.fontSize,
          lineHeight: type.section.lineHeight,
        }}
      />
      {saveError && (
        <Text accessibilityRole="alert" style={{ ...text, color: r.warning }}>
          Not saved: {saveError}. Your text is kept.
        </Text>
      )}
      <Text style={meta}>
        Saving adds the text as a new version. It is not a plan change and
        grants no dispatch authority.
      </Text>
      <View style={row}>
        <Button
          small
          c={c}
          text={saving ? "Saving…" : "Save document"}
          label={`Save the ${name} document`}
          disabled={busy || saving || Boolean(saveBlock)}
          hint={saveBlock || undefined}
          onPress={save}
        />
      </View>
      {saveBlock && <Text style={meta}>{saveBlock}</Text>}
    </View>
  );

  const header = (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: space.md,
      }}
    >
      <View style={{ gap: space.xs, flexShrink: 1, minWidth: 0 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: r.foreground,
            fontSize: type.page.fontSize,
            lineHeight: type.page.lineHeight,
            fontWeight: "600",
          }}
        >
          {name}
        </Text>
        <View style={{ ...row, gap: space.xxs }}>
          {context && (
            <Pill tone="accent" text={horizonTitle(context.horizon)} c={c} />
          )}
          <Pill
            tone={open ? "success" : "muted"}
            text={
              open ? (lane.status === "paused" ? "Paused" : "Open") : "Closed"
            }
            label={`Lane ${open ? (lane.status === "paused" ? "paused" : "open") : "closed"}`}
            c={c}
          />
          {others.map((place) => (
            <Pill
              key={place.key}
              tone="muted"
              text={`Also on ${place.name} (${horizonTitle(place.horizon!)})`}
              c={c}
            />
          ))}
        </View>
      </View>
      {shown === "preview" && (
        <View style={row}>
          {open && onSetStatus && (
            <Button
              small
              c={c}
              text="Mark done"
              label={`Mark done ${name}`}
              disabled={busy}
              onPress={() => setClosing("done")}
            />
          )}
          {!open && onSetStatus && (
            <View style={row}>
              <Button
                small
                c={c}
                text="Reopen"
                label={`Reopen lane ${name}`}
                disabled={busy}
                onPress={() => onSetStatus("active")}
              />
              <ReopenHelp c={c} laneTitle={name} />
            </View>
          )}
          {canEdit && loaded && (
            <ActionButton
              c={c}
              action="edit"
              label={`Edit the ${name} document`}
              disabled={busy}
              onPress={startEdit}
            />
          )}
        </View>
      )}
    </View>
  );
  const main = (
    <View style={{ gap: space.lg }}>
      <View accessibilityLabel="Finish line" style={{ gap: space.xs }}>
        {sectionTitle("Finish line")}
        <View style={box}>
          <Text selectable style={text}>
            {context?.doneWhen || "Not set"}
          </Text>
          {lane.keep && (
            <View
              style={{ paddingTop: space.xxs }}
            >
              <Text selectable style={{ ...text, color: r.muted }}>
                <Text style={{ color: r.foreground, fontWeight: "500" }}>
                  Why it’s still open:{" "}
                </Text>
                {lane.keep.reason}
              </Text>
            </View>
          )}
        </View>
      </View>
      {Boolean(context?.note) && (
        <View accessibilityLabel="Latest status" style={{ gap: space.xs }}>
          {sectionTitle("Latest status")}
          <View style={box}>
            <Text selectable style={text}>
              {context!.note}
            </Text>
            {(context!.author || context!.savedAt) && (
              <Text style={meta}>
                {[
                  context!.author,
                  context!.savedAt ? decisionAge(context!.savedAt) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            )}
          </View>
        </View>
      )}
      {inFlight}
      {waiting}
      {finished}
    </View>
  );
  const sideColumn = (
    <View style={{ gap: space.sm }}>
      {documentBox()}
      {atAGlance}
      {plansBox}
    </View>
  );

  return (
    <View
      accessibilityLabel={`Lane ${name}`}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ gap: space.md }}
    >
      {header}
      {/* The drained-lane row's Nucleus-raised provenance (nucleus#1515): the escalation it answers. */}
      {lane.drain?.escalatedAt && (
        <Text
          accessibilityLabel={`Nucleus-raised: ${name} drained and escalated to you; the plan owner has not answered the close-out prompt`}
          style={{ ...meta, color: r.warning }}
        >
          Nucleus-raised · drained, escalated to you{" "}
          {decisionAge(lane.drain.escalatedAt)} · the plan owner has not
          answered the close-out prompt
        </Text>
      )}
      {closing && onSetStatus && (
        <MarkDoneConfirm
          c={c}
          lane={lane}
          projects={projects}
          plans={plans}
          busy={busy}
          disposition={closing}
          onConfirm={(note) => {
            onSetStatus(closing, note);
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        />
      )}
      {shown === "preview" && (
        <>
          <View accessibilityLabel="Aim" style={box}>
            <Text
              style={{
                ...meta,
                textTransform: "uppercase",
                letterSpacing: planningRead.eyebrowTracking,
              }}
            >
              Aim
            </Text>
            <Text
              selectable
              style={{
                color: r.foreground,
                fontSize: type.section.fontSize,
                lineHeight: type.section.lineHeight,
              }}
            >
              {lane.aim}
            </Text>
          </View>
          <View
            accessibilityLabel="Lane sections"
            style={{
              flexDirection: side ? "row" : "column",
              alignItems: "flex-start",
              gap: space.lg,
            }}
          >
            <View
              style={{
                flex: side ? 1 : undefined,
                minWidth: 0,
                alignSelf: "stretch",
              }}
            >
              {main}
            </View>
            <View
              style={{
                width: side ? planningRead.side : undefined,
                alignSelf: "stretch",
              }}
            >
              {sideColumn}
            </View>
          </View>
        </>
      )}
      {shown === "read" && fullRead}
      {shown === "edit" && editor}
      <View
        style={{
          gap: space.xs,
          paddingTop: space.sm,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${details ? "Hide" : "Show"} details for ${name}`}
          accessibilityState={{ expanded: details }}
          onPress={() => setDetails(!details)}
        >
          <Text style={{ ...text, fontWeight: "600" }}>
            {details ? "▾" : "▸"} Details
          </Text>
        </Pressable>
        {details && (
          <View
            accessibilityLabel={`Lane details for ${name}`}
            style={{ gap: space.xs }}
          >
            <Text selectable style={meta}>
              Key · {lane.key}
            </Text>
            <Text
              selectable
              accessibilityLabel="Lane repositories"
              style={meta}
            >
              Repositories ·{" "}
              {lane.repositories
                .map((repo) => `${repo.origin} (${repo.path})`)
                .join(", ") || "none"}
            </Text>
            {Boolean(lane.note) && (
              <Text selectable style={text}>
                Note · {lane.note}
              </Text>
            )}
            {onSetStatus && (
              <View style={row}>
                {(["active", "done", "abandoned"] as const)
                  .filter((status) => status !== lane.status)
                  .map((status) => (
                    <Button
                      key={status}
                      small
                      c={c}
                      text={statusWord[status]}
                      label={`Set lane ${lane.key} ${status}`}
                      disabled={busy}
                      onPress={() => status === "active" ? onSetStatus(status) : setClosing(status)}
                    />
                  ))}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
