import React, { type ReactNode, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  LaneView,
  LeadListFacts,
  PlanningTriage,
  Project,
  ProjectPlan,
  TaskSummary,
} from "../shared/contracts";
import {
  laneFinderCount,
  laneFinderRows,
  laneFinderScopeLabel,
  lanePlaceLabel,
  type LaneFinderRow,
} from "../shared/lane-finder";
import { effectiveSelection } from "../shared/project-scope";
import {
  activeSteps,
  movePlan,
  planDraftStale,
  planningPlan,
  projectLanes,
  rebaseDraft,
  reorderPlan,
  roadmapView,
  sameOrder,
  type PlanDraft,
  type PlanEntry,
  type PlanningStep,
  type RoadmapStep,
} from "../shared/planning-tab";
import { decisionAge } from "../shared/pipeline-board";
import { formatTelemetryDuration } from "../shared/telemetry";
import {
  ActionButton,
  Button,
  Dialog,
  Field,
  controlFrame,
  controlText,
  muted,
  row,
  type Colors,
} from "./controls";
import {
  overlay,
  radius,
  roles,
  space,
  touchTarget,
  type,
  type as typeScale,
} from "./design";
import { type ProjectActivity } from "../shared/project-activity";
import {
  PROJECT_GROUP_TITLES,
  projectGroup,
  projectLastActivity,
  projectStatus,
  projectStatusParts,
} from "../shared/planning-read";
import type { ProjectBadge } from "../shared/t3/project-badge";
import { ProjectTriage } from "./planning-triage";
import {
  Breadcrumb,
  GroupHeader,
  ProjectRoadmapView,
  ProjectRow,
  type ProjectRowModel,
} from "./planning-roadmap";

/** `error` is set when the plan or its saved version could not be read; `latest` is then the last version read, if any. */
export type PlanSection = {
  project: Project;
  latest?: ProjectPlan;
  saved?: ProjectPlan;
  triage?: PlanningTriage;
  error?: string;
};
/** A draft: the order, horizons and idle change the operator is making, and the version it was based on. See `PlanDraft`. */
export type PlanEdit = PlanDraft;

const HORIZONS = ["now", "next", "later"] as const;
const horizonTitle = (horizon: PlanEntry["horizon"]) =>
  horizon[0].toUpperCase() + horizon.slice(1);
const day = (value: string | null) => value?.slice(0, 10) ?? "No activity";
/** What ends an idle mark. Said in one place so the read and edit copy never drift. */
const IDLE_ENDS = "Saving a changed plan or finishing new work ends it.";

/**
 * The plan editor (nucleus#1531 keeps it unchanged until its own redesign): the roadmap's
 * "Edit plan" opens a draft here with move controls, Save and Cancel, the idle mark and the
 * unplanned lanes. The draft is kept when the plan changes underneath it; Reapply or Reload
 * settles it. Reading is the roadmap (`planning-roadmap.tsx`).
 */
function PlanEditor({
  section,
  leads,
  lanes,
  edits,
  selectedLane,
  busy,
  saveErrors,
  onOpenLane,
  onOpenTask,
  onEdit,
  onSave,
  onCancel,
  onRetry,
  onCloseLane,
  c,
}: {
  section: PlanSection;
  leads: LeadListFacts[];
  lanes: LaneView[];
  edits: Record<string, PlanEdit>;
  selectedLane: string;
  busy: boolean;
  saveErrors?: Record<string, string>;
  onOpenLane: (lane: string) => void;
  onOpenTask?: (id: string) => void;
  onEdit: (project: string, edit: PlanEdit) => void;
  onSave: (project: string, edit: PlanEdit) => void;
  onCancel: (project: string) => void;
  onRetry?: () => void;
  onCloseLane?: (lane: string) => void;
  c: Colors;
}) {
  const [showDone, setShowDone] = useState(false),
    [showUnplanned, setShowUnplanned] = useState(false);
  const [moveOpen, setMoveOpen] = useState<string | null>(null),
    [showIdle, setShowIdle] = useState(false);
  const [idleReason, setIdleReason] = useState("");
  const { project, latest, saved, error } = section;
  const name = project.name;
  const r = roles(c);
  const ready = Boolean(latest);
  const groups = planningPlan(
    latest,
    saved,
    projectLanes(project, lanes).map((lane) => lane.key),
  );
  const basePlan = [...groups.now, ...groups.next, ...groups.later];
  const edit = edits[project.key];
  const editing = Boolean(edit);
  const pending = edit?.entries ?? basePlan;
  const stale = Boolean(edit && planDraftStale(edit.version, latest));
  // Ending an existing mark is a change; a draft that leaves the mark alone is not.
  const idleChanged =
    typeof edit?.idle === "string" ||
    (edit?.idle === null && Boolean(latest?.idle));
  const changed = Boolean(
    edit && (!sameOrder(edit.entries, basePlan) || idleChanged),
  );
  const active = activeSteps(pending);
  const saveError = saveErrors?.[project.key];
  // Save is refused, with the reason shown, rather than sent and failed.
  const saveBlock = !edit
    ? ""
    : stale
      ? "The plan changed. Reapply or reload before saving."
      : !changed
        ? "No changes to save."
        : typeof edit.idle === "string" && active.length
          ? "An idle plan has no Now or Next steps. Move them to Later or clear idle."
          : "";
  const change = (patch: Partial<PlanEdit>) => {
    if (edit) onEdit(project.key, { ...edit, ...patch });
  };
  const startEdit = () =>
    onEdit(project.key, { entries: basePlan, version: latest?.version ?? 0 });
  const roadmap = roadmapView({
    entries: pending,
    unplanned: groups.unplanned.filter(
      (entry) => !pending.some((item) => item.lane === entry.lane),
    ),
    done: latest?.done,
    lanes,
    leads,
  });
  const counts = (item: RoadmapStep) =>
    `${item.tasksDone} done · ${item.tasksLive} live · ${item.openLeads} open leads`;
  const doneWhen = (item: RoadmapStep) =>
    item.doneWhenMissing ? (
      <Text
        accessibilityLabel={`Done-when not set for ${item.lane}`}
        style={{ color: c.statusWarning, fontSize: type.metadata.fontSize }}
      >
        done-when not set
      </Text>
    ) : item.doneWhen ? (
      <Text style={{ color: c.foreground, fontSize: type.metadata.fontSize }}>
        Done when: {item.doneWhen}
      </Text>
    ) : null;
  const controls = (item: RoadmapStep, index: number, group: RoadmapStep[]) => (
    <View style={{ gap: space.xxs }}>
      <View style={row}>
        <Button
          small
          c={c}
          text={moveOpen === item.lane ? "Close move options" : "Move step"}
          label={`Move ${item.title} in ${name}`}
          disabled={busy}
          onPress={() => setMoveOpen(moveOpen === item.lane ? null : item.lane)}
        />
      </View>
      {moveOpen === item.lane && (
        <View accessibilityLabel={`Move ${item.title}`} style={row}>
          <Button
            small
            c={c}
            text="Up"
            label={`Move ${item.title} up`}
            disabled={busy || index === 0}
            onPress={() => {
              change({ entries: reorderPlan(pending, item.lane, -1) });
              setMoveOpen(null);
            }}
          />
          <Button
            small
            c={c}
            text="Down"
            label={`Move ${item.title} down`}
            disabled={busy || index === group.length - 1}
            onPress={() => {
              change({ entries: reorderPlan(pending, item.lane, 1) });
              setMoveOpen(null);
            }}
          />
          {HORIZONS.filter((horizon) => horizon !== item.horizon).map(
            (horizon) => (
              <Button
                key={horizon}
                small
                c={c}
                text={`Move to ${horizonTitle(horizon)}`}
                label={`Move ${item.title} to ${horizonTitle(horizon)} in ${name}`}
                disabled={busy}
                onPress={() => {
                  change({ entries: movePlan(pending, item.lane, horizon) });
                  setMoveOpen(null);
                }}
              />
            ),
          )}
        </View>
      )}
    </View>
  );
  const open = (item: RoadmapStep) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open lane ${item.lane}`}
      onPress={() => onOpenLane(item.lane)}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>
        {item.title}
      </Text>
    </Pressable>
  );
  // Spec 041: the Drained flag carries the episode's age; the prompt already went to the plan owner.
  const drained = (item: RoadmapStep) =>
    item.drained ? (
      <Text
        accessibilityLabel={`Drained ${item.lane}`}
        style={{ color: c.statusWarning, fontSize: type.metadata.fontSize }}
      >
        Drained · {decisionAge(item.drained.since)}
      </Text>
    ) : null;
  const frame = (lane: string) => ({
    padding: space.xs,
    gap: space.xs,
    borderColor: selectedLane === lane ? c.accent : c.border,
    borderWidth: 1,
    borderRadius: radius.control,
    backgroundColor: c.surface0,
  });
  const band = (horizon: (typeof HORIZONS)[number]) => {
    const group = roadmap[horizon];
    return (
      <View
        key={horizon}
        accessibilityLabel={`${horizonTitle(horizon)} band`}
        style={{ gap: space.xs }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontWeight: "600" }}
        >
          {horizonTitle(horizon)}
        </Text>
        {group.map((item, index) =>
          horizon === "now" ? (
            <View
              key={item.lane}
              accessibilityLabel={`Now step ${item.lane}`}
              style={{ ...frame(item.lane), padding: space.sm, gap: space.xs }}
            >
              {open(item)}
              {Boolean(item.aim) && (
                <Text
                  style={{ color: c.foreground, fontSize: type.body.fontSize }}
                >
                  {item.aim}
                </Text>
              )}
              {doneWhen(item)}
              {Boolean(item.note) && <Text style={muted(c)}>{item.note}</Text>}
              <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>
                {counts(item)} · {day(item.lastActivityAt)}
              </Text>
              {drained(item)}
              {editing && controls(item, index, group)}
            </View>
          ) : (
            <View
              key={item.lane}
              accessibilityLabel={`${horizonTitle(horizon)} step ${item.lane}`}
              style={frame(item.lane)}
            >
              <View style={{ ...row, justifyContent: "space-between" }}>
                {open(item)}
                <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>
                  {counts(item)}
                </Text>
              </View>
              {Boolean(item.aim) && (
                <Text
                  style={{ color: c.foreground, fontSize: type.body.fontSize }}
                >
                  {item.aim}
                </Text>
              )}
              {doneWhen(item)}
              {drained(item)}
              {editing && controls(item, index, group)}
            </View>
          ),
        )}
        {!group.length && <Text style={muted(c)}>No steps here.</Text>}
      </View>
    );
  };
  // Idle is a deliberate mark for a plan with nothing in Now or Next. Without that, the draft says how to get there.
  const idleEditor = () => {
    if (typeof edit?.idle === "string")
      return (
        <View style={{ gap: space.xs }}>
          <Text
            accessibilityLabel={`Idle on purpose in draft: ${edit.idle}`}
            style={{
              color: r.foreground,
              fontSize: type.body.fontSize,
              lineHeight: type.body.lineHeight,
            }}
          >
            Idle on purpose: {edit.idle}. {IDLE_ENDS}
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Remove idle mark"
              label={`Remove idle mark from ${name} draft`}
              disabled={busy}
              onPress={() => change({ idle: undefined })}
            />
          </View>
        </View>
      );
    // The saved plan is idle and the draft leaves that alone: ending it is an explicit choice, and the save then carries no mark.
    if (edit?.idle === null)
      return (
        <View style={{ gap: space.xs }}>
          <Text style={muted(c)}>
            The idle mark ends when you save this plan.
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Keep idle"
              label={`Keep ${name} idle`}
              disabled={busy}
              onPress={() => change({ idle: undefined })}
            />
          </View>
        </View>
      );
    if (latest?.idle)
      return (
        <View style={{ gap: space.xs }}>
          <Text
            accessibilityLabel={`Idle on purpose: ${latest.idle.reason}`}
            style={{
              color: r.foreground,
              fontSize: type.body.fontSize,
              lineHeight: type.body.lineHeight,
            }}
          >
            Idle on purpose since {day(latest.idle.at)}: {latest.idle.reason}.{" "}
            {IDLE_ENDS}
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="End idle"
              label={`End idle mark on ${name} plan`}
              disabled={busy}
              onPress={() => change({ idle: null })}
            />
          </View>
        </View>
      );
    if (active.length) {
      const now = active.filter((item) => item.horizon === "now").length,
        next = active.filter((item) => item.horizon === "next").length;
      const counted = [now && `${now} Now`, next && `${next} Next`]
        .filter(Boolean)
        .join(" and ");
      return (
        <View style={{ gap: space.xs }}>
          <Text style={muted(c)}>
            Idle is for a plan with nothing in Now or Next. To go idle, move the{" "}
            {counted} {active.length === 1 ? "step" : "steps"} to Later first.
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Move all to Later"
              label={`Move all ${name} steps to Later`}
              disabled={busy}
              onPress={() =>
                change({
                  entries: pending.map((item) => ({
                    ...item,
                    horizon: "later" as const,
                  })),
                })
              }
            />
          </View>
        </View>
      );
    }
    return (
      <View style={{ gap: space.xs }}>
        <Field
          label="Idle reason"
          placeholder="Why nothing is planned now"
          value={idleReason}
          onChange={(value) => setIdleReason(value.slice(0, 300))}
          c={c}
          detail={`Idle is for a plan with nothing in Now or Next. ${IDLE_ENDS}`}
          disabled={busy}
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Mark plan idle"
            label={`Mark ${name} plan idle`}
            disabled={busy || !idleReason.trim()}
            onPress={() => {
              change({ idle: idleReason.trim() });
              setIdleReason("");
            }}
          />
        </View>
      </View>
    );
  };
  const panelBox = {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.control,
    borderWidth: 1,
    backgroundColor: r.section,
  } as const;
  return (
    <View accessibilityLabel={`Plan for ${name}`} style={{ gap: space.sm }}>
      <View style={{ ...row, justifyContent: "space-between" }}>
        <Text
          accessibilityRole="header"
          style={{
            color: c.foreground,
            fontSize: type.section.fontSize,
            fontWeight: "600",
          }}
        >
          Plan · {name}
        </Text>
        <View style={row}>
          {ready && !editing && (
            <ActionButton
              c={c}
              action="edit"
              label={`Edit ${name} plan`}
              disabled={busy}
              onPress={startEdit}
            />
          )}
        </View>
      </View>
      {!ready &&
        (error ? (
          <View accessibilityRole="alert" style={panelBox}>
            <Text style={{ color: r.foreground }}>
              Couldn’t load this plan: {error}
            </Text>
            {onRetry && (
              <View style={row}>
                <Button
                  small
                  c={c}
                  text="Retry plan"
                  label={`Retry ${name} plan`}
                  disabled={busy}
                  onPress={onRetry}
                />
              </View>
            )}
          </View>
        ) : (
          <Text style={muted(c)}>Loading plan…</Text>
        ))}
      {ready && latest && (
        <>
          {error && (
            <View accessibilityRole="alert" style={panelBox}>
              <Text
                style={{
                  color: r.warning,
                  fontSize: type.metadata.fontSize,
                  lineHeight: type.metadata.lineHeight,
                }}
              >
                Showing version {latest.version}. The latest plan could not be
                refreshed: {error}. It may be out of date.
              </Text>
              {onRetry && (
                <View style={row}>
                  <Button
                    small
                    c={c}
                    text="Retry refresh"
                    label={`Retry refreshing ${name} plan`}
                    disabled={busy}
                    onPress={onRetry}
                  />
                </View>
              )}
            </View>
          )}
          {edit && stale && (
            <View
              accessibilityRole="alert"
              accessibilityLabel={`Plan changed for ${name}`}
              style={{ ...panelBox, borderColor: r.warning }}
            >
              <Text style={{ color: r.foreground, fontWeight: "600" }}>
                The plan changed while you were editing
              </Text>
              <Text style={muted(c)}>
                Version {latest.version} is saved now. Your draft is based on
                version {edit.version} and is kept.
              </Text>
              <Text style={muted(c)}>
                Reapply keeps your order and Now, Next and Later choices for
                steps the saved plan still has. Reload discards the draft.
              </Text>
              <View style={row}>
                <Button
                  small
                  c={c}
                  text="Reapply my changes"
                  label={`Reapply my changes to ${name} plan`}
                  disabled={busy}
                  onPress={() =>
                    onEdit(project.key, {
                      ...edit,
                      entries: rebaseDraft(edit.entries, basePlan),
                      version: latest.version,
                    })
                  }
                />
                <Button
                  small
                  c={c}
                  text="Reload plan"
                  label={`Reload ${name} plan and discard draft`}
                  disabled={busy}
                  onPress={() => onCancel(project.key)}
                />
              </View>
            </View>
          )}
          {edit ? (
            <View
              accessibilityLabel={`Draft plan for ${name}`}
              style={{ ...panelBox, borderColor: r.accent }}
            >
              <Text style={{ color: r.foreground, fontWeight: "600" }}>
                Draft · based on version {edit.version}
              </Text>
              <Text style={muted(c)}>
                {changed
                  ? "Unsaved changes. Nothing is saved until you press Save plan."
                  : "No changes yet."}
              </Text>
              {saveError && !stale && (
                <Text
                  accessibilityRole="alert"
                  style={{
                    color: r.warning,
                    fontSize: type.metadata.fontSize,
                    lineHeight: type.metadata.lineHeight,
                  }}
                >
                  Not saved: {saveError}. Your draft is kept.
                </Text>
              )}
              <View style={row}>
                <Button
                  small
                  c={c}
                  text="Save plan"
                  label={`Save ${name} plan`}
                  disabled={busy || Boolean(saveBlock)}
                  hint={saveBlock || undefined}
                  onPress={() => onSave(project.key, edit)}
                />
                <Button
                  small
                  c={c}
                  text="Cancel"
                  label={`Cancel ${name} plan changes`}
                  disabled={busy}
                  onPress={() => onCancel(project.key)}
                />
              </View>
              {saveBlock && <Text style={muted(c)}>{saveBlock}</Text>}
            </View>
          ) : (
            <Text style={muted(c)}>Version {latest.version}</Text>
          )}
          {!edit && latest.idle && (
            <Text
              accessibilityLabel={`Idle on purpose: ${latest.idle.reason}`}
              style={{ color: c.foreground, fontSize: type.metadata.fontSize }}
            >
              Idle on purpose since {day(latest.idle.at)}: {latest.idle.reason}.{" "}
              {IDLE_ENDS}
            </Text>
          )}
          {edit && (
            <View style={{ gap: space.xs }}>
              <View style={row}>
                <Button
                  small
                  c={c}
                  text={showIdle ? "Hide idle options" : "Idle options"}
                  label={`${showIdle ? "Hide" : "Show"} idle options for ${name} plan`}
                  onPress={() => setShowIdle(!showIdle)}
                />
              </View>
              {showIdle && idleEditor()}
            </View>
          )}
          {!latest.version && !pending.length && (
            <Text style={muted(c)}>
              No plan yet.
              {roadmap.unplanned.length
                ? editing
                  ? " Add the unplanned lanes below to start one."
                  : " Edit plan to start one from the unplanned lanes below."
                : " No lanes for this project yet."}
            </Text>
          )}
          {HORIZONS.map(band)}
          <View accessibilityLabel="Done band" style={{ gap: space.xs }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Done, ${roadmap.done.length}`}
              accessibilityState={{ expanded: showDone }}
              onPress={() => setShowDone(!showDone)}
            >
              <Text style={{ color: c.foreground, fontWeight: "600" }}>
                {showDone ? "▾" : "▸"} Done · {roadmap.done.length}
              </Text>
            </Pressable>
            {showDone &&
              roadmap.done.map((item) => (
                <View
                  key={item.lane}
                  accessibilityLabel={`Done step ${item.lane}`}
                  style={frame(item.lane)}
                >
                  <View style={{ ...row, justifyContent: "space-between" }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open lane ${item.lane}`}
                      onPress={() => onOpenLane(item.lane)}
                    >
                      <Text style={{ color: c.foreground, fontWeight: "600" }}>
                        {item.title}
                      </Text>
                    </Pressable>
                    <Text
                      style={{ ...muted(c), fontSize: type.metadata.fontSize }}
                    >
                      {item.status} · {day(item.closedAt)}
                    </Text>
                  </View>
                  {Boolean(item.note) && (
                    <Text style={muted(c)}>{item.note}</Text>
                  )}
                </View>
              ))}
            {showDone && !roadmap.done.length && (
              <Text style={muted(c)}>Nothing finished yet.</Text>
            )}
          </View>
          {roadmap.unplanned.length > 0 && (
            <View
              accessibilityLabel="Unplanned lanes"
              style={{ gap: space.xs }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${roadmap.unplanned.length} unplanned lanes`}
                accessibilityState={{ expanded: showUnplanned }}
                onPress={() => setShowUnplanned(!showUnplanned)}
              >
                <Text style={{ color: c.foreground, fontWeight: "600" }}>
                  {showUnplanned ? "▾" : "▸"} {roadmap.unplanned.length}{" "}
                  unplanned lanes
                </Text>
              </Pressable>
              {showUnplanned &&
                roadmap.unplanned.map((item) => (
                  <View
                    key={item.lane}
                    style={{
                      ...row,
                      justifyContent: "space-between",
                      borderColor: c.border,
                      borderWidth: 1,
                      borderRadius: radius.control,
                      padding: space.xs,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open lane ${item.lane}`}
                      onPress={() => onOpenLane(item.lane)}
                    >
                      <Text style={{ color: c.foreground }}>{item.title}</Text>
                    </Pressable>
                    <View style={row}>
                      {editing ? (
                        <ActionButton
                          c={c}
                          action="add"
                          label={`Add ${item.lane} to ${name} plan`}
                          disabled={busy}
                          onPress={() =>
                            change({
                              entries: [
                                ...pending,
                                {
                                  lane: item.lane,
                                  note: item.note,
                                  horizon: "later",
                                },
                              ],
                            })
                          }
                        />
                      ) : (
                        <Text style={muted(c)}>Edit plan to add</Text>
                      )}
                      {onCloseLane && (
                        <Button
                          small
                          c={c}
                          text="Close"
                          label={`Close lane ${item.lane}`}
                          disabled={busy}
                          onPress={() => onCloseLane(item.lane)}
                        />
                      )}
                    </View>
                  </View>
                ))}
            </View>
          )}
        </>
      )}
      {section.triage && (
        <ProjectTriage
          project={name}
          triage={section.triage}
          onOpenTask={onOpenTask}
          c={c}
        />
      )}
    </View>
  );
}

const statusWord: Record<LaneView["status"], string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  abandoned: "Abandoned",
};

/**
 * "Find lanes": the search that replaces the separate Lanes destination
 * (nucleus#866). It searches the lane records the agent CLI reads, with a scope
 * that is either the chosen project or a clearly labelled all-projects scope. A
 * result names its project and status; opening it keeps the originating plan
 * context, because the plan column stays where it was.
 */
export function LaneFinderResults({
  rows,
  total,
  query,
  loading,
  error,
  plansError,
  allProjects = true,
  onRetry,
  onOpenLane,
  selectedLane,
  c,
}: {
  rows: LaneFinderRow[];
  total: number;
  query: string;
  loading: boolean;
  error?: string;
  plansError?: string;
  /** Whether the search already spans every project, so the copy never offers a scope that is already in force. */
  allProjects?: boolean;
  onRetry?: () => void;
  onOpenLane: (lane: string) => void;
  selectedLane: string;
  c: Colors;
}) {
  const r = roles(c);
  // A failed read is said first: the board has no lane list yet while it is failing, and
  // "Loading…" would hide the failure behind a spinner that never resolves (#866 review).
  if (error)
    return (
      <View
        accessibilityRole="alert"
        style={{
          gap: space.xs,
          padding: space.sm,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: r.danger,
          backgroundColor: r.section,
        }}
      >
        <Text style={{ color: r.foreground }}>
          Couldn't load lanes: {error}
        </Text>
        <Text
          style={{
            ...muted(c),
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
          }}
        >
          The list may be incomplete. Nothing found here is a total until it
          loads.
        </Text>
        {onRetry && (
          <View style={row}>
            <Button
              small
              c={c}
              text="Retry lanes"
              label="Retry loading lanes"
              onPress={onRetry}
            />
          </View>
        )}
      </View>
    );
  if (loading) return <Text style={muted(c)}>Loading lanes…</Text>;
  const needle = query.trim();
  return (
    <View style={{ gap: space.xs }}>
      <View style={{ ...row, justifyContent: "space-between" }}>
        <Text
          accessibilityLabel="Lane search count"
          style={{
            ...muted(c),
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
          }}
        >
          {laneFinderCount(rows.length, total)}
        </Text>
        {plansError && (
          <Text
            accessibilityRole="alert"
            style={{
              color: r.warning,
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
              flexShrink: 1,
            }}
          >
            Plan positions may be out of date: {plansError}
          </Text>
        )}
      </View>
      {!rows.length &&
        (needle ? (
          <Text style={{ color: r.foreground }}>
            No lanes match “{needle}”. Clear the search
            {allProjects ? "" : " or search all projects"}.
          </Text>
        ) : (
          <Text style={{ color: r.foreground }}>
            No lanes in this scope.
            {allProjects ? "" : " Search all projects to look wider."}
          </Text>
        ))}
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={`Open lane ${row.title}, ${row.places.map((place) => place.name).join(" and ")}, ${statusWord[row.status]}`}
          onPress={() => onOpenLane(row.key)}
          style={{
            gap: space.xxs,
            padding: space.sm,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: selectedLane === row.key ? r.accent : r.border,
            backgroundColor: r.section,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: space.xs,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: r.foreground,
                fontWeight: "600",
                fontSize: type.body.fontSize,
                lineHeight: type.body.lineHeight,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {row.title}
            </Text>
            <Text
              style={{
                flexShrink: 0,
                color: row.status === "active" ? r.foreground : r.muted,
                fontSize: type.metadata.fontSize,
                lineHeight: type.metadata.lineHeight,
              }}
            >
              {statusWord[row.status]}
            </Text>
          </View>
          {Boolean(row.aim) && (
            <Text
              numberOfLines={2}
              style={{
                color: r.foreground,
                fontSize: type.metadata.fontSize,
                lineHeight: type.metadata.lineHeight,
              }}
            >
              {row.aim}
            </Text>
          )}
          <Text
            style={{
              color: r.muted,
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
            }}
          >
            {row.places
              .map((place) => `${place.name} · ${lanePlaceLabel(place)}`)
              .join("  ·  ")}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The inbox board's Planning (Tom, 2026-11-21): the plan fills the list pane and
 * the open lane the detail pane, or a modal when the board has no detail pane.
 * The board header's project filter scopes it, so Planning has no chooser of its own.
 */
export type PlanningInbox = { listWidth: number | null; laneModal: boolean };
/** What the lane page learns from Planning: the plan it was opened from, and a way to show another project's plan (false when that project is out of scope). */
export type PlanningLaneContext = {
  project: string | null;
  showProject: (project: string) => boolean;
};

export function PlanningTab({
  sections: allSections,
  leads = [],
  lanes,
  projects: allProjects,
  projectActivity = [],
  selection = [],
  plans: allPlans,
  plansError,
  lanesLoading = false,
  lanesError,
  edits,
  saveErrors,
  selectedLane,
  step,
  compact,
  busy,
  lanePanel,
  onRetryPlans,
  onRetryLanes,
  onStep,
  onOpenLane,
  onOpenTask,
  onEdit,
  onSave,
  onCancel,
  onCloseLane,
  inbox: inboxLayout,
  repositoryBadges,
  tasks = [],
  queuedCounts = [],
  readPlanVersion,
  c,
}: {
  /** The pane layout; without it the plan fills the panel and the lane opens in a modal. */
  inbox?: PlanningInbox;
  sections: PlanSection[];
  leads?: LeadListFacts[];
  lanes: LaneView[];
  edits: Record<string, PlanEdit>;
  saveErrors?: Record<string, string>;
  selectedLane: string;
  step: PlanningStep;
  compact: boolean;
  busy: boolean;
  /** The open lane's page. A function receives the plan it was opened from and a way to show another project's plan. */
  lanePanel: ReactNode | ((context: PlanningLaneContext) => ReactNode);
  /** Project badges by repository path, for the list rows and the roadmap header. */
  repositoryBadges?: Readonly<Record<string, ProjectBadge>>;
  /** The board's live tasks and its held-back queued counts: a project row counts each task once (Spec 019). */
  tasks?: TaskSummary[];
  queuedCounts?: readonly { repoPath: string; count: number }[];
  /** Reads one saved version of a project's plan (`plan.get`), for History. */
  readPlanVersion?: (project: string, version: number) => Promise<ProjectPlan>;
  /** Every project and its plan, so the chooser and the lane search see past the tab's own scope. */
  projects?: Project[];
  selection?: readonly string[];
  plans?: ProjectPlan[];
  /** Spec 026 (nucleus#1446): the store-wide activity behind the Dormant group, shared with the board selector. */
  projectActivity?: readonly ProjectActivity[];
  /** A plan read that failed keeps its last version; the lane search then says its positions may be stale. */
  plansError?: string;
  lanesLoading?: boolean;
  lanesError?: string;
  onRetryLanes?: () => void;
  /** Reads the plans again after a failed read. */
  onRetryPlans?: () => void;
  onStep: (step: PlanningStep) => void;
  onOpenLane: (lane: string) => void;
  onOpenTask?: (id: string) => void;
  onEdit: (project: string, edit: PlanEdit) => void;
  onSave: (project: string, edit: PlanEdit) => void;
  onCancel: (project: string) => void;
  onCloseLane?: (lane: string) => void;
  c: Colors;
}) {
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState(false);
  const [allScope, setAllScope] = useState(false);
  const projects = allProjects ?? allSections.map((section) => section.project);
  const plans =
    allPlans ??
    allSections
      .flatMap((section) => [section.latest, section.saved])
      .filter((plan): plan is ProjectPlan => Boolean(plan));
  // The search follows the chooser unless the operator asks for the all-projects scope, which is always labelled.
  const searching = Boolean(query.trim()) || browse;
  const searchSelection =
    allScope || !effectiveSelection(projects, selection).length
      ? []
      : selection;
  const scopeLabel = laneFinderScopeLabel(projects, searchSelection);
  // The finder reads the lane records only while it is open; the plan column costs nothing otherwise.
  const scoped = searching
    ? laneFinderRows({ lanes, projects, plans, selection: searchSelection })
    : [];
  const rows = searching
    ? laneFinderRows({
        lanes,
        projects,
        plans,
        selection: searchSelection,
        query,
      })
    : [];
  const activityByKey = new Map(
    projectActivity.map((item) => [item.key, item]),
  );
  const nowMs = Date.now();
  const sections = allSections;
  const [chosen, setChosen] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(0);
  const inbox = inboxLayout ?? { listWidth: null, laneModal: compact };
  // Two panes: the list beside the detail. Otherwise the list drills into the
  // roadmap in place and the lane page opens in the modal (below 1100 points).
  const twoPane = !inbox.laneModal;
  const groupOf = (section: PlanSection) =>
    projectGroup(section.latest, activityByKey.get(section.project.key), nowMs);
  const ordered = (["active", "idle", "dormant"] as const).flatMap((group) =>
    sections.filter((section) => groupOf(section) === group),
  );
  const lists = (section: PlanSection, lane: string) =>
    projectLanes(section.project, lanes).some((item) => item.key === lane) ||
    Boolean(section.latest?.entries.some((entry) => entry.lane === lane));
  const laneOpen = Boolean(selectedLane) && step === "lane";
  const chosenSection = sections.find(
    (section) => section.project.key === chosen,
  );
  // The roadmap shown: the operator's pick, else the plan an open lane belongs to,
  // else (with a detail pane) the first project listed.
  const selectedSection =
    chosenSection ??
    (laneOpen
      ? ordered.find((section) => lists(section, selectedLane))
      : undefined) ??
    (twoPane || sections.length === 1 ? ordered[0] : undefined);
  const laneSection = selectedLane
    ? selectedSection && lists(selectedSection, selectedLane)
      ? selectedSection
      : ordered.find((section) => lists(section, selectedLane))
    : undefined;
  const badgeFor = (project: Project) =>
    [project.primary, ...project.repositories]
      .map((repo) => (repo ? repositoryBadges?.[repo.path] : undefined))
      .find(Boolean) ?? null;
  const rowModel = (section: PlanSection): ProjectRowModel => {
    const group = groupOf(section);
    const base = {
      project: section.project,
      group,
      badge: badgeFor(section.project),
      age: (() => {
        const at = projectLastActivity({
          project: section.project,
          activity: activityByKey.get(section.project.key),
          tasks,
          plan: section.latest,
        });
        return at ? decisionAge(at, nowMs).replace(/ ago$/, "") : null;
      })(),
    };
    const planError = section.error ?? plansError;
    if (planError)
      return {
        ...base,
        state: { kind: "error", subject: "the plan", error: planError },
      };
    if (lanesError)
      return {
        ...base,
        state: { kind: "error", subject: "lanes", error: lanesError },
      };
    if (lanesLoading || !section.latest)
      return { ...base, state: { kind: "loading" } };
    const parts = projectStatusParts(
      group,
      section.latest,
      projectStatus({
        project: section.project,
        plan: section.latest,
        tasks,
        queuedCounts,
      }),
    );
    return { ...base, state: { kind: "ready", ...parts } };
  };
  const clearSearch = () => {
    setQuery("");
    setBrowse(false);
  };
  const chosenScope = effectiveSelection(projects, selection);
  const allScopeOn = !chosenScope.length || allScope;
  const pickProject = (key: string) => {
    setChosen(key);
    onStep("plan");
  };
  const showProject = (key: string) => {
    if (!sections.some((section) => section.project.key === key)) return false;
    pickProject(key);
    return true;
  };
  const editorProps = {
    leads,
    lanes,
    edits,
    saveErrors,
    selectedLane,
    busy,
    onOpenLane,
    onOpenTask,
    onEdit,
    onSave,
    onCancel,
    onCloseLane,
    c,
  };
  const startEdit = (section: PlanSection) => {
    const groups = planningPlan(section.latest, section.saved);
    onEdit(section.project.key, {
      entries: [...groups.now, ...groups.next, ...groups.later],
      version: section.latest?.version ?? 0,
    });
  };
  const roadmapFor = (section: PlanSection) =>
    edits[section.project.key] ? (
      <PlanEditor section={section} {...editorProps} onRetry={onRetryPlans} />
    ) : (
      <ProjectRoadmapView
        // Each project's roadmap keeps its own History and Finished state.
        key={section.project.key}
        section={section}
        group={groupOf(section)}
        badge={badgeFor(section.project)}
        lanes={lanes}
        leads={leads}
        // Without a detail pane the roadmap shares the list pane, so its columns always stack.
        width={twoPane ? detailWidth : 0}
        stacked={!twoPane}
        readPlanVersion={readPlanVersion}
        busy={busy}
        onOpenLane={onOpenLane}
        onEditPlan={section.latest ? () => startEdit(section) : undefined}
        onRetry={onRetryPlans}
        onOpenTask={onOpenTask}
        c={c}
      />
    );
  const backToList = () => {
    setChosen(null);
    onStep("plan");
  };
  const laneTitle =
    lanes.find((lane) => lane.key === selectedLane)?.title ?? selectedLane;
  const laneCrumb = (
    <Breadcrumb
      c={c}
      items={[
        {
          text: "Planning",
          label: "Back to Planning",
          // With a detail pane the list is already beside it, so Planning returns to the lane's plan.
          onPress:
            twoPane || sections.length === 1
              ? () =>
                  laneSection
                    ? pickProject(laneSection.project.key)
                    : onStep("plan")
              : backToList,
        },
        ...(laneSection
          ? [
              {
                text: laneSection.project.name,
                label: `Back to ${laneSection.project.name}`,
                onPress: () => pickProject(laneSection.project.key),
              },
            ]
          : []),
        { text: laneTitle },
      ]}
    />
  );
  const laneBody =
    typeof lanePanel === "function"
      ? lanePanel({
          project: laneSection?.project.key ?? null,
          showProject,
        })
      : lanePanel;
  const lanePage = (
    <View style={{ gap: space.md }}>
      {laneCrumb}
      {laneBody}
    </View>
  );
  const projectList = (
    <>
      {!sections.length && (
        <Text style={{ ...muted(c), padding: space.md }}>No projects yet.</Text>
      )}
      {(["active", "idle", "dormant"] as const).map((group) => {
        const members = ordered.filter((section) => groupOf(section) === group);
        if (!members.length) return null;
        return (
          <View
            key={group}
            accessibilityLabel={`${PROJECT_GROUP_TITLES[group]} projects`}
            style={{ gap: space.xxs / 2 }}
          >
            <GroupHeader title={PROJECT_GROUP_TITLES[group]} c={c} />
            {members.map((section) => (
              <ProjectRow
                key={section.project.key}
                model={rowModel(section)}
                selected={section.project.key === selectedSection?.project.key}
                onPress={() => pickProject(section.project.key)}
                onRetry={onRetryPlans}
                c={c}
              />
            ))}
          </View>
        );
      })}
    </>
  );
  // Without a detail pane, a picked project's roadmap takes the list pane, with the way back above it.
  const drilled = !twoPane && !searching && selectedSection;
  const listBody = searching ? (
    <LaneFinderResults
      rows={rows}
      total={scoped.length}
      query={query}
      loading={lanesLoading}
      error={lanesError}
      plansError={plansError}
      allProjects={allScopeOn}
      onRetry={onRetryLanes}
      onOpenLane={onOpenLane}
      selectedLane={selectedLane}
      c={c}
    />
  ) : drilled ? (
    <View style={{ gap: space.md }}>
      {sections.length > 1 && (
        <Breadcrumb
          c={c}
          items={[
            {
              text: "Planning",
              label: "Back to Planning",
              onPress: backToList,
            },
            { text: selectedSection.project.name },
          ]}
        />
      )}
      {roadmapFor(selectedSection)}
    </View>
  ) : (
    projectList
  );
  const listStyle = inbox.listWidth
    ? {
        width: inbox.listWidth,
        minHeight: 0,
        borderRightWidth: 1,
        borderRightColor: c.border,
      }
    : { flex: 1, minHeight: 0 };
  return (
    <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
      <View
        style={listStyle}
        onLayout={
          twoPane
            ? undefined
            : (event) => setDetailWidth(event.nativeEvent.layout.width)
        }
      >
        <View
          accessibilityLabel="Planning header"
          style={{
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingTop: space.md,
            paddingBottom: space.sm,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: space.xs,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                color: c.foreground,
                fontSize: type.section.fontSize,
                lineHeight: type.section.lineHeight,
                fontWeight: "600",
              }}
            >
              Planning
            </Text>
            {sections.length > 0 && (
              <Text
                style={{
                  ...muted(c),
                  fontSize: type.metadata.fontSize,
                  lineHeight: type.metadata.lineHeight,
                }}
              >
                {sections.length}{" "}
                {sections.length === 1 ? "project" : "projects"}
              </Text>
            )}
          </View>
          <View style={{ ...row, flexWrap: "nowrap" }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <TextInput
                accessibilityLabel="Find lanes"
                value={query}
                onChangeText={setQuery}
                placeholder="Find lanes"
                placeholderTextColor={roles(c).muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ ...controlFrame(c), ...controlText(c) }}
              />
            </View>
            {searching ? (
              <Button
                small
                c={c}
                text="Back to plan"
                label="Close lane search"
                onPress={clearSearch}
              />
            ) : (
              <Button
                small
                c={c}
                text="Browse"
                label="Browse all lanes"
                onPress={() => setBrowse(true)}
              />
            )}
          </View>
          {searching && (
            <View style={row}>
              {Boolean(chosenScope.length) && (
                <Button
                  small
                  c={c}
                  text={laneFinderScopeLabel(projects, chosenScope)}
                  label={`Search lanes in ${laneFinderScopeLabel(projects, chosenScope)}`}
                  selected={!allScopeOn}
                  onPress={() => setAllScope(false)}
                />
              )}
              <Button
                small
                c={c}
                text="All projects"
                label="Search lanes in all projects"
                selected={allScopeOn}
                onPress={() => setAllScope(true)}
              />
            </View>
          )}
          {searching && (
            <Text
              accessibilityLabel="Lane search scope"
              style={{
                ...muted(c),
                fontSize: type.metadata.fontSize,
                lineHeight: type.metadata.lineHeight,
              }}
            >
              Searching{" "}
              {scopeLabel === "All projects" ? "all projects" : scopeLabel}.{" "}
              {query.trim()
                ? "Results match the title, aim or project."
                : "Every lane in scope is listed."}
            </Text>
          )}
        </View>
        <ScrollView
          accessibilityLabel={
            searching ? "Lane search results" : "Planning plan"
          }
          style={{
            flex: 1,
            minHeight: 0,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
          contentContainerStyle={
            searching || drilled
              ? { padding: space.md, gap: space.md }
              : { paddingBottom: space.md }
          }
        >
          {listBody}
        </ScrollView>
      </View>
      {twoPane && (
        <ScrollView
          accessibilityLabel={laneOpen ? "Planning lane" : "Planning project"}
          onLayout={(event) => setDetailWidth(event.nativeEvent.layout.width)}
          style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}
          contentContainerStyle={{
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.xl,
            gap: space.md,
          }}
        >
          {laneOpen ? (
            lanePage
          ) : selectedSection ? (
            roadmapFor(selectedSection)
          ) : (
            <Text style={muted(c)}>Select a project to see its plan.</Text>
          )}
        </ScrollView>
      )}
      {!twoPane && laneOpen && (
        <Dialog
          c={c}
          title="Lane"
          label="Lane detail"
          closeLabel="Close lane"
          bodyLabel="Planning lane"
          backdropLabel="Close lane detail"
          wide
          onClose={() => onStep("plan")}
        >
          {lanePage}
        </Dialog>
      )}
    </View>
  );
}
