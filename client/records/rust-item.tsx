/**
 * The lead and papercut view (Spec 071, "Leads and papercuts"): one engine item in
 * the task view's frame. The header says what state it is in; a panel holds the
 * decision that state asks for (send to planner, revisit, follow the task, or the
 * drop's outcome); the body and its activity follow; Park and Drop sit in the footer,
 * with Drop apart and asking for a disposition first.
 */
import { useContext, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon, useRpc } from "../shell";
import { BoardLiveContext } from "../board-live";
import { Button, Dialog, DropdownSelect, Field, HelpTip, row, type Colors } from "../controls";
import { radius, roles, space, taskDetail, toneSurface, wash, type as typeScale } from "../design";
import { errorText } from "../error-text";
import { Markdown } from "../markdown";
import * as api from "../../shared/contracts";
import type { ItemDetail, ItemHistoryEntry } from "../../shared/contracts";
import { defaultRecheckDate, recheckDateLabel, recheckIsoFromDate } from "../../shared/parking";
import { relativeAge } from "../../shared/pipeline-board";
import { generatedProjectBadge, type ProjectBadge } from "../../shared/t3/project-badge";
import { BoardCard, BoardCardVariantContext, ProjectBadgeMark } from "../board/cards";
import { isRustHttpError, rustCardAgeAt, rustTaskLabel, type RustTask } from "../web/rust-board";
import { RustTaskProgress } from "../task/rust-progress";
import { Dot, Hint, QuietButton, metaText, toneColor } from "../task/rust-detail-parts";
import { ActivityList, Card, Collapsible } from "../task/rust-task-cards";
import { clockTime, type TimelineTone } from "../task/rust-timeline";

type Footer = "park" | "drop" | null;
/**
 * The editor's text and the version it was written against. After a refused save,
 * `saved` holds the newer stored content so the operator sees it before choosing.
 */
type Draft = {
  title: string;
  body: string;
  version: number;
  saved: { title: string; body: string; version: number } | null;
};

const DAY_MS = 86_400_000;

/** Whether a parked item's revisit day has come. Reaching it never reopens the item. */
export function revisitDue(revisitAt: string | null, now = Date.now()): boolean {
  return revisitAt !== null && Date.parse(revisitAt) <= now;
}

/** The revisit day relative to today, in words: "In 7 days", "Due today", "Due 2 days ago". */
export function revisitWords(revisitAt: string, now = new Date()): string {
  const day = new Date(revisitAt);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(day) - start(now)) / DAY_MS);
  if (days > 1) return `In ${days} days`;
  if (days === 1) return "Tomorrow";
  if (days === 0) return "Due today";
  if (days === -1) return "Due yesterday";
  return `Due ${-days} days ago`;
}

/** The stored instant as the local `YYYY-MM-DD` the date field edits. */
function localDay(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The state line's words and tone. */
export function itemState(item: ItemDetail, now = Date.now()): { label: string; tone: TimelineTone } {
  switch (item.state) {
    case "open":
      return { label: "Open", tone: "accent" };
    case "parked":
      return revisitDue(item.revisitAt, now)
        ? { label: "Parked · revisit due", tone: "warning" }
        : { label: "Parked", tone: "muted" };
    case "promoted":
      return { label: "Promoted", tone: "success" };
    case "dropped":
      return item.disposition === "completed"
        ? { label: "Dropped · completed", tone: "success" }
        : { label: "Dropped · deprecated", tone: "muted" };
  }
}

/** The history entry that put the item in its current state, if it was recorded. */
function stateEntry(item: ItemDetail): ItemHistoryEntry | undefined {
  const action = { open: null, parked: "park", promoted: "promote", dropped: "drop" }[item.state];
  return action ? item.history.findLast((entry) => entry.action === action) : undefined;
}

const ACTIONS: Record<string, string> = {
  add: "Filed",
  edit: "Edited",
  park: "Parked",
  reopen: "Reopened",
  assess: "Sent to planner",
  assess_blocked: "Planner not started",
  assess_reached: "Reached a planner",
  promote: "Promoted",
};

/** The latest assessment send since the item was filed or last reopened. */
function latestAssess(item: ItemDetail): ItemHistoryEntry | undefined {
  for (let i = item.history.length - 1; i >= 0; i--) {
    const entry = item.history[i]!;
    if (entry.action === "assess") return entry;
    if (entry.action === "drop" || entry.action === "promote" || entry.action === "reopen") return undefined;
  }
  return undefined;
}

/** Why the latest assessment send is still waiting for a planner, if it is. */
function assessCause(item: ItemDetail): string | null {
  const last = item.history.findLast((entry) =>
    ["assess", "assess_blocked", "assess_reached", "drop", "promote", "reopen"].includes(entry.action));
  return last?.action === "assess_blocked" ? last.note : null;
}

/** The item's history as activity, newest first. Imports and unknown actions keep their own word. */
export function itemActivity(item: ItemDetail) {
  return item.history
    .map((entry, index) => {
      const text =
        entry.action === "drop"
          ? `Dropped as ${entry.disposition ?? "deprecated"}`
          : (ACTIONS[entry.action] ?? entry.action.replaceAll("_", " "));
      const tone: TimelineTone =
        entry.action === "promote" || (entry.action === "drop" && entry.disposition === "completed")
          ? "success"
          : entry.action === "park" || entry.action === "drop"
            ? "muted"
            : "accent";
      const detail = [entry.actorLabel ?? entry.actor, entry.recipientLabel ?? entry.recipient, entry.note].filter(Boolean).join(" · ") || null;
      const detailHint = [entry.actor, entry.recipient].filter(Boolean).join(" · ");
      return { key: `${index}`, at: entry.atMs, text, detail, detailHint: detailHint || undefined, tone };
    })
    .sort((a, b) => b.at - a.at);
}

export function RustItemDialog({
  id,
  project,
  kind,
  inline,
  c,
  onClose,
  laneName,
  badge,
  task,
  onOpenTask,
}: {
  id: string;
  /** The board key of the item's project. */
  project?: string;
  /** The kind the board opened, until the record loads. */
  kind: "lead" | "papercut";
  inline: boolean;
  compact?: boolean;
  c: Colors;
  onClose: () => void;
  laneName: (key: string) => string;
  badge: (projectKey: string) => ProjectBadge | null;
  /** The promoted task's board summary, joined from the board's task list. */
  task: (id: string) => RustTask | undefined;
  onOpenTask: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const getItem = useRpc(api.itemGet),
    editItem = useRpc(api.itemEdit),
    parkItem = useRpc(api.itemPark),
    dropItem = useRpc(api.itemDrop),
    reopenItem = useRpc(api.itemReopen),
    assessItem = useRpc(api.itemAssess);
  const key = ["nucleus", "item", id, project];
  // The planning event refreshes an open item; without the stream it reads on an interval.
  const live = useContext(BoardLiveContext);
  const query = useQuery({
    queryKey: key,
    queryFn: () => getItem({ id, ...(project ? { project } : {}) }),
    refetchInterval: live ? false : 4000,
  });
  const item = query.data;
  const [footer, setFooter] = useState<Footer>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "warning" | "success" } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [parkReason, setParkReason] = useState("");
  const [parkDay, setParkDay] = useState(() => defaultRecheckDate());
  const [revisitDay, setRevisitDay] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<"completed" | "deprecated">("completed");
  const [dropNote, setDropNote] = useState("");

  const r = roles(c);
  const word = (item?.kind ?? kind) === "papercut" ? "Papercut" : "Lead";
  const bodyTitle = word === "Papercut" ? "What happened" : "Lead";

  /** Runs one write; the saved item replaces the view and the board's lists reload. */
  const act = async (write: () => Promise<ItemDetail | void>) => {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await write();
      if (saved) queryClient.setQueryData(key, saved);
      else await query.refetch();
      void queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
      void queryClient.invalidateQueries({ queryKey: ["nucleus", "plans"] });
      setFooter(null);
      return true;
    } catch (error) {
      setNotice({ text: errorText(error), tone: "warning" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const projectKey = item?.projectKey ?? project ?? "";
  const projectName = item?.projectName ?? "";
  const mark = badge(projectKey) ?? (projectName || projectKey ? generatedProjectBadge(projectName.trim() || projectKey) : null);
  const state = item ? itemState(item) : null;
  const heading = (
    <View style={{ gap: space.xxs }}>
      <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        {mark && <ProjectBadgeMark badge={mark} c={c} />}
        {projectName ? <Text style={metaText(c)}>{projectName}</Text> : null}
        <View style={{ ...row, flexWrap: "nowrap", gap: space.xxs }}>
          <Icon name={word === "Papercut" ? "Scissors" : "Lightbulb"} size={12} color={metaText(c).color} />
          <Text style={metaText(c)}>{word}</Text>
        </View>
      </View>
      <Text accessibilityRole="header" style={{ ...typeScale.section, fontWeight: "600", color: r.foreground }}>
        {item?.title ?? word}
      </Text>
      {state && (
        <View accessibilityLabel={`State: ${state.label}`} style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
          <Dot c={c} tone={state.tone} />
          <Text style={{ ...typeScale.body, color: metaText(c).color }}>{state.label}</Text>
        </View>
      )}
    </View>
  );
  const frame = {
    c,
    wide: true,
    inline,
    title: item?.title ?? word,
    heading,
    label: `${word} detail`,
    bodyLabel: word,
    closeLabel: `Close ${word.toLowerCase()}`,
    backdropLabel: `Close ${word.toLowerCase()}`,
    onClose,
  } as const;

  if (!item) {
    return (
      <Dialog {...frame}>
        {query.error ? (
          <View style={{ ...row, gap: space.xs }}>
            <Text accessibilityRole="alert" style={{ ...typeScale.body, color: r.warning, flex: 1 }}>
              {errorText(query.error)}
            </Text>
            <Button c={c} small text="Retry" onPress={() => void query.refetch()} />
          </View>
        ) : (
          <Text style={metaText(c)}>{`Loading ${word.toLowerCase()}…`}</Text>
        )}
      </Dialog>
    );
  }

  const active = item.state === "open" || item.state === "parked";
  const entry = stateEntry(item);
  const address = { id: item.id, project: item.projectKey };
  const assessed = latestAssess(item);
  const activity = itemActivity(item);

  const age = <ItemAge c={c} item={item} entry={entry} />;

  const footerBar = active ? (
    <View style={{ ...row, gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: r.hairline }}>
      {footer === "park" ? (
        <ParkForm
          c={c}
          busy={busy}
          reason={parkReason}
          setReason={setParkReason}
          day={parkDay}
          setDay={setParkDay}
          onPark={(revisitAt) => void act(() => parkItem({ ...address, reason: parkReason.trim(), revisitAt }))}
          onKeep={() => setFooter(null)}
        />
      ) : footer === "drop" ? (
        <View accessibilityLabel="Drop form" style={{ ...row, gap: space.xs, flex: 1, justifyContent: "flex-end" }}>
          {item.kind === "papercut" && (
            <DropdownSelect
              c={c}
              compact
              hideLabel
              minWidth={140}
              label="Disposition"
              value={disposition}
              options={[
                { value: "completed", label: "Completed" },
                { value: "deprecated", label: "Deprecated" },
              ]}
              disabled={busy}
              onChange={(value) => setDisposition(value === "deprecated" ? "deprecated" : "completed")}
            />
          )}
          <View style={{ flex: 1, minWidth: 160, maxWidth: 320 }}>
            <Field c={c} label="Note" hideLabel placeholder="Note" value={dropNote} onChange={setDropNote} disabled={busy} />
          </View>
          <Button
            c={c}
            small
            danger
            text="Drop"
            label={`Drop ${word.toLowerCase()}`}
            disabled={busy}
            onPress={() =>
              void act(() =>
                dropItem({
                  ...address,
                  // Leads have no completed outcome to record (Spec 071).
                  disposition: item.kind === "papercut" ? disposition : "deprecated",
                  note: dropNote.trim(),
                }),
              )
            }
          />
          <Button c={c} small text="Keep" label={`Keep ${word.toLowerCase()}`} onPress={() => setFooter(null)} />
        </View>
      ) : (
        <>
          {item.state === "open" && (
            <Button c={c} small text="Park" label={`Park ${word.toLowerCase()}`} disabled={busy} onPress={() => setFooter("park")} />
          )}
          <View style={{ flex: 1 }} />
          <QuietButton c={c} danger text="Drop" label={`Open drop for ${word.toLowerCase()}`} disabled={busy}
            onPress={() => setFooter("drop")} />
        </>
      )}
    </View>
  ) : null;

  const reopen = (
    <Button c={c} small text="Reopen" label={`Reopen ${word.toLowerCase()}`} disabled={busy}
      onPress={() => void act(() => reopenItem({ ...address, version: item.version }))} />
  );

  const body = (
    <>
      <Markdown text={item.body} c={c} />
      <ContextLine c={c} item={item} laneName={laneName} />
    </>
  );

  return (
    <Dialog {...frame} headerActions={age} footer={footerBar}>
      {notice && (
        <Text accessibilityRole="alert" style={{ ...typeScale.body, color: notice.tone === "success" ? r.success : r.warning }}>
          {notice.text}
        </Text>
      )}
      {active && (
        <AssessPanel
          c={c}
          item={item}
          assessed={assessed}
          cause={assessCause(item)}
          busy={busy}
          onAssess={() => {
            void (async () => {
              if (busy) return;
              setBusy(true);
              setNotice(null);
              try {
                const saved = await assessItem({ ...address, version: item.version });
                queryClient.setQueryData(key, saved);
                void queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
              } catch (error) {
                if (isRustHttpError(error, 409)) {
                  await query.refetch();
                  setNotice({
                    text: `This ${word.toLowerCase()} changed since you opened it. It has been reloaded; check it and send again.`,
                    tone: "warning",
                  });
                } else setNotice({ text: errorText(error), tone: "warning" });
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      )}
      {item.state === "parked" && (
        <Panel c={c} label="Parked" tone={revisitDue(item.revisitAt) ? "warning" : "muted"} eyebrow="Parked" by={entry?.actorLabel} byHint={entry?.actor}>
          <Text selectable style={{ ...typeScale.body, color: r.foreground }}>{item.reason || "Parked without a reason."}</Text>
          <View style={{ ...row, gap: space.xs }}>
            <Text style={metaText(c)}>Revisit</Text>
            <RevisitField
              c={c}
              busy={busy}
              stored={item.revisitAt}
              value={revisitDay ?? localDay(item.revisitAt)}
              onChange={setRevisitDay}
              onSave={(revisitAt) =>
                void act(() => parkItem({ ...address, reason: item.reason || "Parked", revisitAt })).then(
                  (ok) => ok && setRevisitDay(null),
                )
              }
            />
            <View style={{ flex: 1 }} />
            {reopen}
          </View>
        </Panel>
      )}
      {item.state === "promoted" && (
        <LinkedTask c={c} taskId={item.taskId} task={item.taskId ? task(item.taskId) : undefined} onOpenTask={onOpenTask} />
      )}
      {item.state === "dropped" && (
        <Panel
          c={c}
          label={item.disposition === "completed" ? "Completed" : "Deprecated"}
          tone={item.disposition === "completed" ? "success" : "muted"}
          eyebrow={item.disposition === "completed" ? "Completed" : "Deprecated"}
          by={entry?.actorLabel}
          byHint={entry?.actor}
        >
          <Text selectable style={{ ...typeScale.body, color: item.reason ? r.foreground : metaText(c).color }}>
            {item.reason || "No note."}
          </Text>
          <View style={{ ...row, gap: space.xs }}>
            <View style={{ flex: 1 }} />
            {reopen}
          </View>
        </Panel>
      )}
      {active ? (
        <Card c={c} label={bodyTitle}>
          <View style={{ ...row, flexWrap: "nowrap" }}>
            <Text accessibilityRole="header" style={{ ...typeScale.body, fontWeight: "600", color: r.foreground, flex: 1 }}>
              {bodyTitle}
            </Text>
            {!draft && (
              <QuietButton c={c} text="Edit" label={`Edit ${word.toLowerCase()}`} disabled={busy}
                onPress={() => setDraft({ title: item.title, body: item.body, version: item.version, saved: null })} />
            )}
          </View>
          {draft ? (
            <EditForm
              c={c}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSave={() => {
                const opened = draft;
                // A replace after a refusal writes over the stored version the operator was shown.
                const version = opened.saved?.version ?? opened.version;
                void (async () => {
                  setBusy(true);
                  setNotice(null);
                  try {
                    const saved = await editItem({ ...address, version, title: opened.title.trim(), body: opened.body });
                    queryClient.setQueryData(key, saved);
                    void queryClient.invalidateQueries({ queryKey: ["nucleus", "leads"] });
                    setDraft(null);
                  } catch (error) {
                    if (!isRustHttpError(error, 409)) {
                      setNotice({ text: errorText(error), tone: "warning" });
                      return;
                    }
                    // Keep the draft and show what is stored now; nothing is replaced until the operator chooses.
                    const fresh = (await query.refetch()).data;
                    setNotice({
                      text: `This ${word.toLowerCase()} changed since you opened the editor. Compare the saved version below, then keep it or replace it with your edit.`,
                      tone: "warning",
                    });
                    if (fresh)
                      setDraft((current) =>
                        current && { ...current, saved: { title: fresh.title, body: fresh.body, version: fresh.version } },
                      );
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
          ) : (
            body
          )}
        </Card>
      ) : (
        <Collapsible c={c} title={bodyTitle} open={bodyOpen} onToggle={() => setBodyOpen(!bodyOpen)}>
          {body}
        </Collapsible>
      )}
      {activity.length > 0 && (
        <Collapsible c={c} title="Activity" open={activityOpen} onToggle={() => setActivityOpen(!activityOpen)}>
          <ActivityList c={c} entries={activity} limit={null} />
        </Collapsible>
      )}
    </Dialog>
  );
}

function ItemAge({ c, item, entry }: { c: Colors; item: ItemDetail; entry: ItemHistoryEntry | undefined }) {
  const at = entry?.atMs ?? item.createdAtMs;
  if (at === null) return null;
  const verb = { open: "Filed", parked: "Parked", promoted: "Promoted", dropped: "Dropped" }[item.state];
  const filed = item.createdAtMs;
  const edited = item.history.findLast((record) => record.action === "edit")?.atMs ?? null;
  const tip = [
    entry ? `${verb} ${clockTime(entry.atMs)}${entry.actorLabel ? ` · ${entry.actorLabel}` : ""}${entry.actor ? ` (${entry.actor})` : ""}` : null,
    filed !== null && (entry || item.state === "open") ? `Filed ${clockTime(filed)}` : null,
    edited !== null ? `Edited ${clockTime(edited)}` : null,
  ]
    .filter((line, index, lines) => line && lines.indexOf(line) === index)
    .join("\n");
  return (
    <Hint c={c} text={tip} focusable style={{ marginRight: space.xs, alignSelf: "center" }}>
      <Text style={metaText(c)}>{relativeAge(at)}</Text>
    </Hint>
  );
}

/** The tinted panel: an eyebrow with who acted on the right, then its content. */
function Panel({
  c,
  label,
  tone,
  eyebrow,
  by,
  byHint,
  help,
  children,
}: {
  c: Colors;
  label: string;
  tone: TimelineTone;
  eyebrow: string;
  by?: string;
  byHint?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  const r = roles(c);
  const color = toneColor(tone, c);
  return (
    <View
      accessibilityLabel={label}
      style={{ gap: space.xs, padding: space.sm, borderRadius: radius.panel, backgroundColor: toneSurface(color, r.section, wash.tone) }}
    >
      <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        <Text
          style={{
            ...typeScale.metadata,
            fontWeight: "600",
            letterSpacing: taskDetail.eyebrowTracking,
            textTransform: "uppercase",
            color,
          }}
        >
          {eyebrow}
        </Text>
        {help}
        <View style={{ flex: 1 }} />
        {by ? (
          byHint ? (
            <Hint c={c} text={byHint} focusable><Text style={metaText(c)}>{by}</Text></Hint>
          ) : <Text style={metaText(c)}>{by}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function AssessPanel({
  c,
  item,
  assessed,
  cause,
  busy,
  onAssess,
}: {
  c: Colors;
  item: ItemDetail;
  assessed: ItemHistoryEntry | undefined;
  cause: string | null;
  busy: boolean;
  onAssess: () => void;
}) {
  const [help, setHelp] = useState(false);
  const helpText =
    "The planner will check this item, drop it if it's stale or already done, or write a brief and dispatch it.";
  return (
    <Panel
      c={c}
      label="Send to planner"
      tone="accent"
      eyebrow="Send to planner"
      help={<HelpTip c={c} label="About sending to planner" text={helpText} open={help} onOpenChange={setHelp} />}
    >
      <View style={{ ...row, gap: space.xs }}>
        {assessed ? (
          <>
            <Hint c={c} text={new Date(assessed.atMs).toLocaleString()} focusable>
              <Text style={metaText(c)}>{`With planner since ${clockTime(assessed.atMs)}`}</Text>
            </Hint>
            {assessed.recipient ? (
              <Hint c={c} text={assessed.recipient} focusable>
                <Text style={metaText(c)}>{`· ${assessed.recipientLabel ?? "Agent thread"}`}</Text>
              </Hint>
            ) : null}
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button
          c={c}
          small
          selected={!assessed}
          text={assessed ? "Send again" : "Send to planner"}
          label={assessed ? `Send ${item.kind} to planner again` : `Send ${item.kind} to planner`}
          disabled={busy}
          onPress={onAssess}
        />
      </View>
      {cause ? (
        <Text accessibilityRole="alert" selectable style={{ ...typeScale.body, color: roles(c).warning }}>
          {cause}
        </Text>
      ) : null}
    </Panel>
  );
}

function ParkForm({
  c,
  busy,
  reason,
  setReason,
  day,
  setDay,
  onPark,
  onKeep,
}: {
  c: Colors;
  busy: boolean;
  reason: string;
  setReason: (value: string) => void;
  day: string;
  setDay: (value: string) => void;
  onPark: (revisitAt: string | null) => void;
  onKeep: () => void;
}) {
  const when = day.trim() ? recheckIsoFromDate(day) : null;
  const invalid = Boolean(day.trim()) && !when;
  return (
    <View accessibilityLabel="Park form" style={{ ...row, gap: space.xs, flex: 1 }}>
      <View style={{ flex: 2, minWidth: 180 }}>
        <Field c={c} label="Park reason" hideLabel placeholder="Reason" value={reason} onChange={setReason} disabled={busy} />
      </View>
      <View style={{ flex: 1, minWidth: 120, maxWidth: 160 }}>
        <Field c={c} label="Revisit on" hideLabel placeholder="YYYY-MM-DD" value={day} onChange={setDay} disabled={busy} />
      </View>
      <Button
        c={c}
        small
        text="Park"
        label="Park"
        hint={invalid ? "Revisit needs a day after today, as YYYY-MM-DD, or blank." : undefined}
        disabled={busy || !reason.trim() || invalid}
        onPress={() => onPark(when)}
      />
      <Button c={c} small text="Keep" label="Keep open" onPress={onKeep} />
    </View>
  );
}

/** The revisit day: editing it to another valid day offers Save, which parks again with it. */
function RevisitField({
  c,
  busy,
  stored,
  value,
  onChange,
  onSave,
}: {
  c: Colors;
  busy: boolean;
  stored: string | null;
  value: string;
  onChange: (value: string) => void;
  onSave: (revisitAt: string | null) => void;
}) {
  const when = value.trim() ? recheckIsoFromDate(value) : null;
  const invalid = Boolean(value.trim()) && !when;
  const changed = value.trim() !== localDay(stored);
  const tip = stored
    ? `${recheckDateLabel(stored)} · ${revisitWords(stored)}. Changing it parks again with the new date.`
    : "No revisit date. Setting one parks again with it.";
  return (
    <>
      <Hint c={c} text={tip} style={{ width: 130 }}>
        <Field c={c} label="Revisit" hideLabel placeholder="YYYY-MM-DD" value={value} onChange={onChange} disabled={busy} />
      </Hint>
      {stored && !changed && <Text style={metaText(c)}>{revisitWords(stored)}</Text>}
      {changed && (
        <Button
          c={c}
          small
          text="Save"
          label="Save revisit date"
          hint={invalid ? "Revisit needs a day after today, as YYYY-MM-DD, or blank." : undefined}
          disabled={busy || invalid}
          onPress={() => onSave(when)}
        />
      )}
    </>
  );
}

function EditForm({
  c,
  draft,
  setDraft,
  busy,
  onSave,
}: {
  c: Colors;
  draft: Draft;
  setDraft: (draft: Draft | null) => void;
  busy: boolean;
  onSave: () => void;
}) {
  const r = roles(c);
  const saved = draft.saved;
  const empty = !draft.title.trim() || !draft.body.trim();
  return (
    <View style={{ gap: space.xs }}>
      <Field c={c} label="Title" value={draft.title} onChange={(title) => setDraft({ ...draft, title })} disabled={busy} />
      <Field c={c} label="Body" multiline value={draft.body} onChange={(body) => setDraft({ ...draft, body })} disabled={busy} />
      {saved && (
        <View
          accessibilityLabel="Saved version"
          style={{ gap: space.xs, padding: space.sm, borderRadius: radius.panel, borderWidth: 1, borderColor: r.hairline }}
        >
          <Text style={{ ...metaText(c), fontWeight: "600" }}>Saved version</Text>
          <Text selectable style={{ ...typeScale.body, fontWeight: "600", color: r.foreground }}>{saved.title}</Text>
          <Markdown text={saved.body} c={c} />
        </View>
      )}
      <View style={{ ...row, gap: space.xs }}>
        <View style={{ flex: 1 }} />
        <Button c={c} small text="Cancel" label="Cancel edit" onPress={() => setDraft(null)} />
        {saved ? (
          <>
            <Button c={c} small text="Use saved" label="Use the saved version" disabled={busy}
              onPress={() => setDraft({ title: saved.title, body: saved.body, version: saved.version, saved: null })} />
            <Button c={c} small selected text="Replace saved" label="Replace the saved version" disabled={busy || empty}
              onPress={onSave} />
          </>
        ) : (
          <Button c={c} small selected text="Save" label="Save changes" disabled={busy || empty} onPress={onSave} />
        )}
      </View>
    </View>
  );
}

/** Lanes, repositories and author under the body. */
function ContextLine({ c, item, laneName }: { c: Colors; item: ItemDetail; laneName: (key: string) => string }) {
  const r = roles(c);
  const label = (text: string) => <Text style={{ ...metaText(c), fontWeight: "600" }}>{text}</Text>;
  return (
    <View style={{ ...row, gap: space.md, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: r.hairline }}>
      {item.lanes.length > 0 && (
        <View style={{ ...row, gap: space.xs }}>
          {label(item.lanes.length > 1 ? "Lanes" : "Lane")}
          {item.lanes.map((lane) => (
            <Text key={lane} style={{ ...metaText(c), paddingHorizontal: space.xs, borderRadius: radius.full, backgroundColor: r.raised }}>
              {laneName(lane)}
            </Text>
          ))}
        </View>
      )}
      {item.repositories.length > 0 && (
        <View style={{ ...row, gap: space.xs }}>
          {label(item.repositories.length > 1 ? "Repositories" : "Repository")}
          <Text style={metaText(c)}>{item.repositories.map((repo) => repo.origin).join(", ")}</Text>
        </View>
      )}
      {item.author ? (
        <View style={{ ...row, gap: space.xs }}>
          {label("By")}
          <Hint c={c} text={item.author} focusable><Text style={metaText(c)}>{item.authorLabel ?? "Agent thread"}</Text></Hint>
        </View>
      ) : null}
    </View>
  );
}

/** The promoted item's task, as its board card; pressing it opens the task view. */
function LinkedTask({
  c,
  taskId,
  task,
  onOpenTask,
}: {
  c: Colors;
  taskId: string | null;
  task: RustTask | undefined;
  onOpenTask: (id: string) => void;
}) {
  if (!taskId) {
    return (
      <Panel c={c} label="Promoted" tone="success" eyebrow="Promoted">
        <Text style={metaText(c)}>The engine recorded no task for this promotion.</Text>
      </Panel>
    );
  }
  const reference = task ? rustTaskLabel(task) : taskId;
  const title = task?.title || reference;
  return (
    <BoardCardVariantContext.Provider value="card">
      <BoardCard
        c={c}
        kind="task"
        selected={false}
        label={`Open task ${reference}`}
        meta={reference}
        title={title}
        status={task ? { tone: task.phase === "done" ? "success" : task.attention === "attention" ? "warning" : "muted", state: task.stateLabel } : { tone: "muted", state: "Not on the board" }}
        age={task && rustCardAgeAt(task) !== null ? relativeAge(rustCardAgeAt(task)!) : null}
        progress={task ? <RustTaskProgress task={task} c={c} /> : undefined}
        onPress={() => onOpenTask(taskId)}
      />
    </BoardCardVariantContext.Provider>
  );
}
