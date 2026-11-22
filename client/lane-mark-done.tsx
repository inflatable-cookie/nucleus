import React, { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { LaneView, Project, ProjectPlan } from "../shared/contracts";
import { lanePlaces } from "../shared/lane-finder";
import { horizonTitle } from "../shared/planning-read";
import {
  Button,
  Dialog,
  HelpPopover,
  HelpTip,
  row,
  type Colors,
} from "./controls";
import { roles, type as type } from "./design";

/** The lane facts a mark-done confirmation needs: its plans and its live work. */
export type MarkDoneLane = Pick<
  LaneView,
  "key" | "title" | "repositories" | "liveByPhase"
>;

/** Live tasks summed across phases, the count the confirmation names. */
export function markDoneLiveTasks(lane: Pick<LaneView, "liveByPhase">): number {
  return Object.values(lane.liveByPhase).reduce(
    (sum, count) => sum + count,
    0,
  );
}

/**
 * The small confirmation before a lane is marked done (nucleus#1536): it names
 * every project plan that lists the lane and the number of live tasks if it has
 * any, with Mark done and Cancel. Closing the dialog cancels too.
 */
export function MarkDoneConfirm({
  c,
  lane,
  projects,
  plans,
  busy = false,
  onConfirm,
  onCancel,
}: {
  c: Colors;
  lane: MarkDoneLane;
  projects: readonly Project[];
  plans: readonly ProjectPlan[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const r = roles(c);
  const body = {
    color: r.foreground,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  } as const;
  const listed = lanePlaces(lane, projects, plans).filter(
    (place) => place.horizon,
  );
  const live = markDoneLiveTasks(lane);
  return (
    <Dialog
      c={c}
      title={`Mark ${lane.title} done?`}
      label={`Mark ${lane.title} done confirmation`}
      closeLabel="Close confirmation"
      onClose={onCancel}
      bodyLabel={`Mark ${lane.title} done confirmation`}
      footer={
        <View style={row}>
          <Button
            small
            danger
            c={c}
            text="Mark done"
            label={`Mark ${lane.title} done`}
            disabled={busy}
            onPress={onConfirm}
          />
          <Button
            small
            c={c}
            text="Cancel"
            label={`Cancel marking ${lane.title} done`}
            onPress={onCancel}
          />
        </View>
      }
    >
      <Text style={body}>
        It moves to Finished lanes on every plan that lists it. You can reopen
        it.
      </Text>
      <Text selectable style={body}>
        {listed.length
          ? `Plans: ${listed
              .map(
                (place) => `${place.name} (${horizonTitle(place.horizon!)})`,
              )
              .join(", ")}.`
          : "No plan lists this lane yet."}
      </Text>
      {live > 0 && (
        <Text style={body}>
          {live} {live === 1 ? "live task" : "live tasks"}.
        </Text>
      )}
    </Dialog>
  );
}

/**
 * The (?) beside Reopen: the explanation lives in the popover, not inline
 * (the settings UI convention, Tom 2026-11-08).
 */
export function ReopenHelp({
  c,
  laneTitle,
}: {
  c: Colors;
  laneTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  const text = "Returns the lane to its saved plan position.";
  return (
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      <HelpTip
        c={c}
        label={`Reopen lane ${laneTitle}`}
        text={text}
        open={open}
        onOpenChange={setOpen}
      />
      {open && (
        <HelpPopover
          c={c}
          anchor={anchor}
          label={`Reopen lane ${laneTitle}`}
          text={text}
        />
      )}
    </View>
  );
}
