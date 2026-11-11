import { errorText } from "./error-text";
import React, { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Icon } from "./shell";
import { Button, HelpPopover, HelpTip, muted, row, type Colors } from "./controls";
import { radius, roles, space, type } from "./design";
import { BACKUP_DUE_CHECK_MS, BACKUP_INTERVAL_MS, BACKUP_STALE_AFTER_MS, type BackupList } from "../shared/contracts";
import { formatLocalDateTime } from "../shared/date-time";

type Entry = BackupList["snapshots"][number];
type Tier = Entry["kind"];
const TIERS: readonly Tier[] = ["hourly", "daily", "weekly"];
/** One stored snapshot: its hourly, daily and weekly names are hard links of one file, so they share a row. */
export type SnapshotRow = { key: string; at: string; size: number; tiers: Tier[]; manual: boolean };

/** The file stem every tier of one snapshot shares (`core/store/backup-worker.mjs` names them `<stem>.<tier>.sqlite.gz`). */
const stemOf = (name: string) => name.replace(/\.(?:hourly|daily|weekly)\.sqlite\.gz$/, "");

/** Collapse tiers that share one file into one row, newest first. */
export function snapshotRows(snapshots: readonly Entry[]): SnapshotRow[] {
  const rows = new Map<string, SnapshotRow>();
  for (const entry of snapshots) {
    const key = stemOf(entry.name);
    const found = rows.get(key);
    if (found) {
      if (!found.tiers.includes(entry.kind)) found.tiers.push(entry.kind);
      found.manual ||= entry.manual === true;
      found.size = Math.max(found.size, entry.size);
    } else rows.set(key, { key, at: entry.at, size: entry.size, tiers: [entry.kind], manual: entry.manual === true });
  }
  return [...rows.values()]
    .map(item => ({ ...item, tiers: TIERS.filter(tier => item.tiers.includes(tier)) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

/** A coarse age: minutes under two hours, hours under two days, then days. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** Below this panel width (a phone) a snapshot's labels sit under its date; at the settings width a row is one line. */
const ONE_LINE_MIN_WIDTH = 520;

/**
 * Settings → Backups (Spec 028, nucleus#965): the stored snapshots, newest first, under
 * a one-line summary. Problems read as one warning line; where snapshots live, the
 * schedule, retention and the restore procedure wait behind the `?`. There is no
 * restore action here: restore is an operator procedure (docs/knowledge/operations/restore.md).
 */
export function BackupsPanel({ c, list, loading, loadError, health, inset, backUp, now = Date.now() }: {
  c: Colors;
  list: BackupList | undefined;
  loading: boolean;
  loadError: unknown;
  /** The board projection's snapshot health: the newest scheduled snapshot and the last failure. */
  health: { newestSnapshotAt: string | null; localError: string | null } | undefined;
  inset: number;
  /** Take a snapshot and refresh the list; resolves when both settle. */
  backUp: () => Promise<unknown>;
  now?: number;
}) {
  const r = roles(c);
  const [running, setRunning] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [width, setWidth] = useState(0);
  const anchor = useRef<View | null>(null);
  const rows = list ? snapshotRows(list.snapshots) : [];
  const newestListed = list?.snapshots.reduce<string | null>((best, entry) => entry.verified && (!best || entry.at > best) ? entry.at : best, null) ?? null;
  const newestAt = health?.newestSnapshotAt ?? newestListed;
  const ageMs = newestAt ? now - Date.parse(newestAt) : Infinity;
  const stale = ageMs > BACKUP_STALE_AFTER_MS;
  const localError = health?.localError ?? list?.localError ?? null;
  const failure = localError ?? (loadError ? `Couldn't load the snapshot list: ${errorText(loadError)}` : null);
  // The schedule keys off the newest hourly file (`newestScheduledSnapshotAt`), checked every 15 minutes.
  const dueAt = newestAt ? Date.parse(newestAt) + BACKUP_INTERVAL_MS : null;
  const due = dueAt === null || dueAt <= now ? "next due now" : `next due ${clock(dueAt)}`;
  const problem = failure
    ? (newestAt ? `Backups are failing: ${failure}` : `No verified snapshot: ${failure}`)
    : newestAt && stale ? `Newest verified snapshot is ${formatAge(ageMs).replace(" ago", " old")}; one is due every ${BACKUP_INTERVAL_MS / 3_600_000} h`
      : null;
  const retention = list?.retention;
  const help = [
    list?.dir ? `Snapshots live in ${list.dir}.` : null,
    `A snapshot is taken every ${BACKUP_INTERVAL_MS / 3_600_000} hours (checked every ${BACKUP_DUE_CHECK_MS / 60_000} minutes), before a schema migration, and on Back up now. Each one is verified before it is kept.`,
    retention ? `Rotation keeps ${retention.hourly} hourly, ${retention.daily} daily and ${retention.weekly} weekly; a daily or weekly snapshot is the same file as its hourly one, so one row can carry several tiers.` : null,
    "Restore is an operator procedure: docs/knowledge/operations/restore.md.",
  ].filter(Boolean).join(" ");
  const wide = width === 0 || width >= ONE_LINE_MIN_WIDTH;
  async function press() {
    setRunning(true);
    try { await backUp(); } finally { setRunning(false); }
  }
  return <ScrollView accessibilityLabel="Store backups" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: space.xs, paddingBottom: inset, width: "100%", maxWidth: 780 }}>
    {list?.workRoot && <View style={{ gap: space.xxs, marginBottom: space.md }}>
      <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, fontWeight: "600" }}>Storage</Text>
      <Text style={muted(c)}>Work root</Text>
      <Text selectable accessibilityLabel="Work root" style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>{list.workRoot}</Text>
    </View>}
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      <Text accessibilityRole="header" style={{ color: r.foreground, fontSize: type.section.fontSize, fontWeight: "600" }}>Backups</Text>
      <HelpTip c={c} label="Backups" text={help} open={helpOpen} onOpenChange={setHelpOpen} />
      <View style={{ flex: 1 }} />
      <Button c={c} small text={running ? "Backing up…" : "Back up now"} icon={running ? "LoaderCircle" : undefined} disabled={running}
        hint={running ? "A snapshot is being written and verified" : undefined} onPress={() => void press()} />
    </View>
    {helpOpen && <HelpPopover c={c} anchor={anchor} label="Backups" text={help} />}
    {newestAt && <Text accessibilityLabel="Backup summary" style={muted(c)}>{`Newest verified ${formatAge(ageMs)} · ${due}`}</Text>}
    {problem && <View style={{ ...row, flexWrap: "nowrap", alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}><Icon name="TriangleAlert" size={16} color={r.warning} /></View>
      <Text accessibilityRole="alert" selectable style={{ color: r.warning, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight, flex: 1, minWidth: 0 }}>{problem}</Text>
    </View>}
    {!list && loading && <Text style={muted(c)}>Loading snapshots…</Text>}
    {list && !rows.length && !failure && <Text style={muted(c)}>No snapshots yet</Text>}
    {rows.length > 0 && <View accessibilityLabel="Stored snapshots" style={{ borderRadius: radius.card, backgroundColor: r.section, paddingVertical: space.xxs }}>
      {rows.map((item, index) => <SnapshotLine key={item.key} c={c} item={item} now={now} wide={wide} first={index === 0} />)}
    </View>}
  </ScrollView>;
}

function SnapshotLine({ c, item, now, wide, first }: { c: Colors; item: SnapshotRow; now: number; wide: boolean; first: boolean }) {
  const r = roles(c);
  const age = formatAge(now - Date.parse(item.at));
  const when = formatLocalDateTime(item.at);
  const label = [when, age, formatSize(item.size), item.tiers.join(", "), item.manual ? "manual" : null].filter(Boolean).join(", ");
  // Tiers keep their column (hourly, daily, weekly); manual follows them.
  const chips = <View style={{ flexDirection: "row", gap: space.xxs, ...(wide ? { width: 212 } : {}) }}>
    {item.tiers.map(tier => <Chip key={tier} c={c} text={tier} />)}
    {item.manual && <Chip c={c} text="manual" strong />}
  </View>;
  const border = { borderTopWidth: first ? 0 : 1, borderTopColor: r.border, paddingHorizontal: space.sm };
  // At the settings width a snapshot is one line; a phone-width panel puts the labels under the date.
  if (!wide) return <View accessibilityLabel={`Snapshot ${label}`} style={{ ...border, gap: space.xxs, paddingVertical: space.xs }}>
    <View style={{ ...row, flexWrap: "nowrap", gap: space.sm }}>
      <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, flex: 1, minWidth: 0 }}>{when}</Text>
      <Text numberOfLines={1} style={muted(c)}>{formatSize(item.size)}</Text>
    </View>
    {chips}
  </View>;
  return <View accessibilityLabel={`Snapshot ${label}`} style={{ ...border, ...row, flexWrap: "nowrap", gap: space.sm, minHeight: 36 }}>
    <Text numberOfLines={1} style={{ color: r.foreground, fontSize: type.body.fontSize, flex: 1, minWidth: 0 }}>{when}</Text>
    <Text numberOfLines={1} style={{ ...muted(c), width: 84, textAlign: "right" }}>{age}</Text>
    <Text numberOfLines={1} style={{ ...muted(c), width: 72, textAlign: "right" }}>{formatSize(item.size)}</Text>
    {chips}
  </View>;
}

/** A small neutral label; `strong` lifts it to the foreground so a manual snapshot reads apart from the tiers. */
function Chip({ c, text, strong = false }: { c: Colors; text: string; strong?: boolean }) {
  const r = roles(c);
  return <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: strong ? r.muted : r.border }}>
    <Text numberOfLines={1} style={{ color: strong ? r.foreground : r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>{text}</Text>
  </View>;
}
