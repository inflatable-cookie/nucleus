import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { LeadPark, LeadRecheck } from "../shared/contracts";
import { defaultRecheckDate, parkedCheckLabel, recheckIsoFromDate } from "../shared/parking";
import { Button, Field, HelpPopover, HelpTip, row, type Colors } from "./controls";
import { space, type as typeScale } from "./design";

/** Nucleus#1543: what parking does, in the `?` popover so the fields keep one label each. */
const PARK_HELP = "Parking takes the lead off the to-do list with the reason you give. It stays open and comes back on its recheck day, when the planner is told once. Editing, promoting or dropping it brings it back at once.";

function ParkHelp({ c }: { c: Colors }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return (
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      <HelpTip c={c} label="About parking" text={PARK_HELP} open={open} onOpenChange={setOpen} />
      {open && <HelpPopover c={c} anchor={anchor} label="About parking" text={PARK_HELP} />}
    </View>
  );
}

/** The park's two inputs: a reason, and the day to check again (blank for no date). */
export function ParkFields({ c, reason, onReasonChange, date, onDateChange, disabled }: {
  c: Colors; reason: string; onReasonChange: (value: string) => void; date: string; onDateChange: (value: string) => void; disabled: boolean;
}) {
  return (
    <View style={{ gap: space.xxs }}>
      <Field c={c} label="Park reason" value={reason} onChange={onReasonChange} disabled={disabled} />
      <Field c={c} label="Check again on" value={date} onChange={onDateChange} disabled={disabled} placeholder="YYYY-MM-DD"
        detail="A day after today, or blank for no date." />
      <ParkHelp c={c} />
    </View>
  );
}

/** The parked or due state in words: the reason and the recheck day, or the reason it came due. */
export function ParkedNote({ c, parked, recheck }: { c: Colors; parked: LeadPark | null; recheck: LeadRecheck | null }) {
  const style = { color: c.foreground, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight };
  if (parked) return <Text accessibilityLabel="Parked lead" style={style}>Parked · {parked.reason} · {parkedCheckLabel(parked.revisitAt)}</Text>;
  if (recheck) return <Text accessibilityLabel="Due for a recheck" style={style}>Due for a recheck · {recheck.reason}</Text>;
  return null;
}

/**
 * Park and unpark for one lead or papercut. The parent runs the action and reports its outcome;
 * a day that is not after today is refused here, before anything is sent.
 */
export function ParkPanel({ c, busy, parked, recheck, canPark, parkReason, unparkReason, onPark, onUnpark }: {
  c: Colors; busy: boolean; parked: LeadPark | null; recheck: LeadRecheck | null; canPark: boolean;
  parkReason?: string | null; unparkReason?: string | null;
  onPark: (reason: string, revisitAt: string | null) => void; onUnpark: () => void;
}) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(() => defaultRecheckDate());
  const when = date.trim() ? recheckIsoFromDate(date) : null;
  const dayInvalid = Boolean(date.trim()) && !when;
  const refusal = parkReason ?? (dayInvalid ? "Check again on needs a day after today, as YYYY-MM-DD, or blank" : null);
  return (
    <View style={{ gap: space.xs }}>
      <ParkedNote c={c} parked={parked} recheck={recheck} />
      {parked && <View style={row}><Button small c={c} text="Unpark" label="Return the lead to the to-do list" disabled={busy || Boolean(unparkReason)} hint={unparkReason ?? undefined} onPress={onUnpark} /></View>}
      {canPark && <>
        <ParkFields c={c} reason={reason} onReasonChange={setReason} date={date} onDateChange={setDate} disabled={busy || Boolean(parkReason)} />
        <View style={row}>
          <Button small c={c} text="Park" label="Park the lead" disabled={busy || Boolean(parkReason) || !reason.trim() || dayInvalid} hint={refusal ?? undefined}
            onPress={() => onPark(reason, when)} />
        </View>
      </>}
    </View>
  );
}
