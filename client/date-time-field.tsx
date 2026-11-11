import React, { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { Button, muted, row, type Colors } from "./controls";
import { roles, touchSlop, type } from "./design";
import { useFocusVisible } from "./focus-modality";
import { DAY_MS, MINUTES, MONTH_NAMES, WEEKDAYS, formatLocalDateTime, monthGrid, pad, withDay, withMinute } from "../shared/date-time";

export { formatLocalDateTime } from "../shared/date-time";

/** The next whole hour from now, the default starting point for a fresh pick. */
const nextHour = (now: number) => { const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; };

/**
 * A local date-and-time field. Tapping opens a month calendar with hour and
 * minute choices and a few presets; the value stays an ISO UTC instant (or
 * null when cleared), so callers and RPCs never see local formatting.
 */
export function DateTimeField({ c, label, value, onChange, disabled = false, emptyText = "Not set", now = Date.now }: {
  c: Colors; label: string; value: string | null; onChange: (iso: string | null) => void; disabled?: boolean; emptyText?: string; now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 6, minWidth: 0 }}>
    <Text style={muted(c)}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value ? formatLocalDateTime(value) : emptyText}`} disabled={disabled} onPress={() => setOpen(true)}
      style={{ backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 7, padding: 11, minHeight: 44, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}>
      <Text style={{ color: value ? c.foreground : c.foregroundMuted, fontSize: 16 }}>{value ? formatLocalDateTime(value) : emptyText}</Text>
    </Pressable>
    {open && <DateTimePickerModal c={c} label={label} value={value} now={now} onCancel={() => setOpen(false)} onDone={iso => { setOpen(false); onChange(iso); }} />}
  </View>;
}

/**
 * A date-and-time value as small muted text that opens the same picker (Tom, 2026-11-09:
 * "clickable text rather than a text input so it's small and subtle"). It reads
 * `emptyText` with no value, else `prefix` and the local time; hover or keyboard focus
 * turns it accent. One line: a long value truncates rather than wrapping its row.
 */
export function DateTimeLink({ c, label, value, onChange, prefix = "", emptyText = "Not set", disabled = false, now = Date.now }: {
  c: Colors; label: string; value: string | null; onChange: (iso: string | null) => void; prefix?: string; emptyText?: string; disabled?: boolean; now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const r = roles(c);
  const text = value ? `${prefix}${formatLocalDateTime(value)}` : emptyText;
  const lit = !disabled && (hovered || focus.visible);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${text}`} accessibilityState={{ disabled }} disabled={disabled}
      onPress={() => setOpen(true)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} onFocus={focus.onFocus} onBlur={focus.onBlur}
      hitSlop={touchSlop(type.metadata.lineHeight)} style={{ flexShrink: 1, minWidth: 0, maxWidth: "100%", opacity: disabled ? 0.45 : 1 }}>
      <Text numberOfLines={1} style={{ color: lit ? r.accent : r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight, textDecorationLine: lit ? "underline" : "none" }}>{text}</Text>
    </Pressable>
    {open && <DateTimePickerModal c={c} label={label} value={value} now={now} onCancel={() => setOpen(false)} onDone={iso => { setOpen(false); onChange(iso); }} />}
  </>;
}

function DateTimePickerModal({ c, label, value, now, onCancel, onDone }: { c: Colors; label: string; value: string | null; now: () => number; onCancel: () => void; onDone: (iso: string | null) => void }) {
  const start = value && !Number.isNaN(Date.parse(value)) ? new Date(value) : nextHour(now());
  const [draft, setDraft] = useState(start);
  const [shown, setShown] = useState({ year: start.getFullYear(), month: start.getMonth() });
  const today = new Date(now()); today.setHours(0, 0, 0, 0);
  const setDay = (year: number, month: number, day: number) => setDraft(withDay(draft, year, month, day));
  // Hours and minutes move by elapsed time, so a repeated DST hour keeps the
  // occurrence the operator is looking at instead of snapping to the first one.
  const shift = (ms: number) => setDraft(new Date(draft.getTime() + ms));
  const setMinute = (minute: number) => setDraft(withMinute(draft, minute));
  const preset = (days: number) => { const d = nextHour(now() + days * DAY_MS - 60 * 60 * 1000); setDraft(d); setShown({ year: d.getFullYear(), month: d.getMonth() }); };
  const step = (delta: number) => setShown(s => { const m = s.month + delta; return { year: s.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 }; });
  const inPast = draft.getTime() <= now();
  return <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
    <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.68)" }}>
      <View accessibilityViewIsModal accessibilityLabel={`Pick ${label}`} style={{ maxWidth: 420, width: "100%", alignSelf: "center", gap: 12, padding: 18, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{label}</Text>
        <View style={row}>
          <Button small c={c} text="In 1 day" onPress={() => preset(1)} />
          <Button small c={c} text="In 3 days" onPress={() => preset(3)} />
          <Button small c={c} text="In 1 week" onPress={() => preset(7)} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Button small c={c} text="‹" label="Previous month" onPress={() => step(-1)} />
          <Text style={{ color: c.foreground, fontWeight: "600" }}>{MONTH_NAMES[shown.month]} {shown.year}</Text>
          <Button small c={c} text="›" label="Next month" onPress={() => step(1)} />
        </View>
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row" }}>{WEEKDAYS.map(day => <Text key={day} style={{ ...muted(c), flex: 1, textAlign: "center", fontSize: 11 }}>{day}</Text>)}</View>
          {monthGrid(shown.year, shown.month).map((week, w) => <View key={w} style={{ flexDirection: "row" }}>{week.map((day, i) => {
            if (day === null) return <View key={i} style={{ flex: 1, height: 34 }} />;
            const past = new Date(shown.year, shown.month, day).getTime() < today.getTime();
            const selected = draft.getFullYear() === shown.year && draft.getMonth() === shown.month && draft.getDate() === day;
            return <Pressable key={i} accessibilityRole="button" accessibilityLabel={`${day} ${MONTH_NAMES[shown.month]} ${shown.year}`} accessibilityState={{ selected, disabled: past }} disabled={past}
              onPress={() => setDay(shown.year, shown.month, day)}
              style={{ flex: 1, height: 34, margin: 1, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: selected ? c.accent : "transparent", opacity: past ? 0.35 : 1 }}>
              <Text style={{ color: selected ? c.accentForeground : c.foreground }}>{day}</Text>
            </Pressable>;
          })}</View>)}
        </View>
        <View style={{ ...row, justifyContent: "space-between" }}>
          <View style={row}>
            <Button small c={c} text="−" label="Earlier hour" onPress={() => shift(-60 * 60_000)} />
            <Text accessibilityLabel={`Hour ${pad(draft.getHours())}`} style={{ color: c.foreground, fontSize: 16, minWidth: 28, textAlign: "center" }}>{pad(draft.getHours())}</Text>
            <Button small c={c} text="+" label="Later hour" onPress={() => shift(60 * 60_000)} />
          </View>
          <View style={row}>{MINUTES.map(m => <Button key={m} small c={c} text={`:${pad(m)}`} label={`Minute ${pad(m)}`} selected={draft.getMinutes() === m} onPress={() => setMinute(m)} />)}</View>
        </View>
        <Text style={{ color: inPast ? c.statusWarning : c.foreground }}>{formatLocalDateTime(draft.toISOString())}{inPast ? " is in the past" : ""}</Text>
        <View style={{ ...row, justifyContent: "flex-end" }}>
          <Button small c={c} text="Clear" onPress={() => onDone(null)} />
          <Button small c={c} text="Cancel" onPress={onCancel} />
          <Button small c={c} text="Done" disabled={inPast} onPress={() => {
            // Time passes while the picker is open: recheck at the press and stay open, showing why.
            if (draft.getTime() <= now()) { setDraft(new Date(draft.getTime())); return; }
            onDone(draft.toISOString());
          }} />
        </View>
      </View>
    </View>
  </Modal>;
}
