import React, { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  LaneView,
  LeadListFacts,
  PlanningTriage,
  Project,
  ProjectPlan,
} from "../shared/contracts";
import {
  HORIZON_HINTS,
  PHASE_GROUP_WORDS,
  PLAN_HORIZONS,
  horizonTitle,
  laneAttention,
  lanePhaseGroups,
  planUpdatedLine,
  roadmapBanner,
  type PhaseGroup,
  type PlanHorizon,
  type ProjectGroup,
} from "../shared/planning-read";
import {
  projectLanes,
  roadmapView,
  type RoadmapStep,
} from "../shared/planning-tab";
import { decisionAge } from "../shared/pipeline-board";
import { formatLocalDateTime } from "../shared/date-time";
import type { ProjectBadge } from "../shared/t3/project-badge";
import {
  ActionButton,
  Button,
  SurfacePress,
  row,
  useCardFill,
  type Colors,
} from "./controls";
import { ReopenHelp } from "./lane-mark-done";
import {
  cardRow,
  planningRead,
  radius,
  roles,
  space,
  toneSurface,
  toneWash,
  type,
} from "./design";
import { ProjectBadgeMark } from "./board/cards";
import { Icon } from "./shell";
import { ProjectTriage } from "./planning-triage";

/**
 * Spec 026 Planning read view (nucleus#1531, Tom 2026-11-22: "it's quite impenetrable as a
 * human reading it"). The list pane names where each project stands in words; the detail
 * pane reads one project's plan as a roadmap: the focus, then Now, Next and Later as
 * columns of lane cards, then the finished lanes. Version numbers, step counters and
 * empty tabs stay out of the main view; History and Edit plan hold them.
 */

const meta = (c: Colors) =>
  ({
    color: roles(c).muted,
    fontSize: type.metadata.fontSize,
    lineHeight: type.metadata.lineHeight,
  }) as const;
const body = (c: Colors) =>
  ({
    color: roles(c).foreground,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  }) as const;
/** The small caps label above a banner or a side box. */
const eyebrow = (c: Colors) =>
  ({
    ...meta(c),
    textTransform: "uppercase",
    letterSpacing: planningRead.eyebrowTracking,
  }) as const;

/** A short coloured label: the attention count, a horizon, open or closed. */
export function Pill({
  text,
  tone,
  label,
  c,
}: {
  text: string;
  tone: "warning" | "accent" | "success" | "muted";
  label?: string;
  c: Colors;
}) {
  const r = roles(c);
  const color =
    tone === "warning"
      ? r.warning
      : tone === "accent"
        ? r.accent
        : tone === "success"
          ? r.success
          : r.muted;
  return (
    <Text
      accessibilityLabel={label}
      numberOfLines={1}
      style={{
        color,
        backgroundColor:
          tone === "muted" ? r.raised : toneSurface(color, r.raised),
        borderRadius: radius.full,
        paddingHorizontal: space.xs,
        fontSize: type.metadata.fontSize,
        lineHeight: planningRead.pillHeight,
        fontWeight: "500",
        flexShrink: 0,
      }}
    >
      {text}
    </Text>
  );
}

/** The project's badge, or the folder icon when it has none. Decorative: the name beside it is the label. */
export function ProjectMark({
  badge,
  c,
}: {
  badge?: ProjectBadge | null;
  c: Colors;
}) {
  return badge ? (
    <ProjectBadgeMark badge={badge} c={c} />
  ) : (
    <Icon name="Folder" size={cardRow.tileIcon} color={roles(c).muted} />
  );
}

/** The phase groups' colours, from the theme roles only. */
export function phaseGroupColor(group: PhaseGroup, c: Colors): string {
  const r = roles(c);
  switch (group) {
    case "attention":
      return r.danger;
    case "changes":
      return r.warning;
    case "working":
      return r.accent;
    case "review":
      return toneSurface(r.accent, r.raised, planningRead.reviewAlpha);
    case "merging":
      return r.success;
    case "queued":
      return r.muted;
  }
}

/** The live tasks as one bar, then the counts in words and the finished count. */
export function LaneProgress({
  lane,
  c,
}: {
  lane: Pick<LaneView, "liveByPhase" | "terminalCount" | "title">;
  c: Colors;
}) {
  const groups = lanePhaseGroups(lane);
  const total = groups.reduce((sum, item) => sum + item.count, 0);
  const words = [
    ...groups.map((item) => `${item.count} ${PHASE_GROUP_WORDS[item.group]}`),
    // Finished, not done: the total counts cancelled and superseded work too.
    `${lane.terminalCount.toLocaleString()} finished`,
  ];
  return (
    <View
      accessible
      accessibilityLabel={`Progress for ${lane.title}: ${words.join(", ")}`}
      style={{ gap: space.xxs }}
    >
      {total > 0 && (
        <View
          style={{
            flexDirection: "row",
            height: planningRead.bar,
            borderRadius: radius.full,
            overflow: "hidden",
            backgroundColor: roles(c).raised,
          }}
        >
          {groups.map((item) => (
            <View
              key={item.group}
              style={{
                flexGrow: item.count,
                flexBasis: 0,
                backgroundColor: phaseGroupColor(item.group, c),
              }}
            />
          ))}
        </View>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          columnGap: space.sm,
          rowGap: space.xxs,
        }}
      >
        {groups.map((item) => (
          <View
            key={item.group}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xxs,
            }}
          >
            <View
              style={{
                width: cardRow.dot,
                height: cardRow.dot,
                borderRadius: radius.full,
                backgroundColor: phaseGroupColor(item.group, c),
              }}
            />
            <Text style={meta(c)}>
              {item.count} {PHASE_GROUP_WORDS[item.group]}
            </Text>
          </View>
        ))}
        <Text style={meta(c)}>
          {lane.terminalCount.toLocaleString()} finished
        </Text>
      </View>
    </View>
  );
}

/** One lane on the roadmap: its title and attention, its aim, its live work and its finish line. */
export function LaneCard({
  step,
  lane,
  onOpen,
  c,
}: {
  step: RoadmapStep;
  lane?: LaneView;
  onOpen: () => void;
  c: Colors;
}) {
  const r = roles(c);
  const fill = useCardFill(c);
  const attention = lane ? laneAttention(lane) : 0;
  return (
    <SurfacePress
      label={`Open lane ${step.title}`}
      onPress={onOpen}
      c={c}
      corner={radius.panel}
      style={{
        gap: space.xs,
        padding: space.sm,
        backgroundColor: fill,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: space.xs,
        }}
      >
        <Text
          style={{
            ...body(c),
            fontWeight: "600",
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {step.title}
        </Text>
        <View style={{ flexDirection: "row", gap: space.xxs, flexShrink: 0 }}>
          {attention > 0 && (
            <Pill
              tone="warning"
              text={`${attention} need you`}
              label={`${attention} need you in ${step.title}`}
              c={c}
            />
          )}
          {step.drained && (
            <Pill
              tone="muted"
              text={`Drained · ${decisionAge(step.drained.since)}`}
              label={`Drained ${step.lane}`}
              c={c}
            />
          )}
        </View>
      </View>
      {Boolean(step.aim) && (
        <Text
          numberOfLines={planningRead.aimLines}
          style={{ ...body(c), color: r.muted }}
        >
          {step.aim}
        </Text>
      )}
      {lane && <LaneProgress lane={lane} c={c} />}
      {(step.doneWhen || step.doneWhenMissing) && (
        <View
          style={{ paddingTop: space.xxs }}
        >
          {step.doneWhen ? (
            <Text style={{ ...meta(c), lineHeight: type.body.lineHeight }}>
              <Text style={{ color: r.foreground, fontWeight: "500" }}>
                Done when{" "}
              </Text>
              {step.doneWhen}
            </Text>
          ) : (
            <Text
              accessibilityLabel={`Done-when not set for ${step.lane}`}
              style={{ ...meta(c), color: r.warning }}
            >
              Done when not set
            </Text>
          )}
        </View>
      )}
    </SurfacePress>
  );
}

/** The trail back from a lane page: Planning › Project › Lane. */
export function Breadcrumb({
  items,
  c,
}: {
  items: Array<{ text: string; label?: string; onPress?: () => void }>;
  c: Colors;
}) {
  return (
    <View
      accessibilityLabel="Breadcrumb"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space.xxs,
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={`${index}:${item.text}`}>
          {index > 0 && <Text style={meta(c)}>›</Text>}
          {item.onPress ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={item.label ?? `Back to ${item.text}`}
              onPress={item.onPress}
            >
              <Text style={{ ...body(c), color: roles(c).muted }}>
                {item.text}
              </Text>
            </Pressable>
          ) : (
            <Text numberOfLines={1} style={{ ...body(c), flexShrink: 1 }}>
              {item.text}
            </Text>
          )}
        </React.Fragment>
      ))}
    </View>
  );
}

/** A project row in the list pane: badge and name, last activity, and the status line in words. */
export type ProjectRowModel = {
  project: Project;
  group: ProjectGroup;
  badge?: ProjectBadge | null;
  age: string | null;
  /** Ready rows carry the status words; a failed or loading read says so instead. */
  state:
    | { kind: "ready"; attention: string | null; rest: string }
    | { kind: "loading" }
    | { kind: "error"; subject: string; error: string };
};

export function ProjectRow({
  model,
  selected,
  onPress,
  onRetry,
  c,
}: {
  model: ProjectRowModel;
  selected: boolean;
  onPress: () => void;
  onRetry?: () => void;
  c: Colors;
}) {
  const r = roles(c);
  const { project, state } = model;
  const dim = model.group === "dormant";
  return (
    <View
      style={{
        marginHorizontal: space.xs,
        opacity: dim && !selected ? planningRead.dormantOpacity : 1,
      }}
    >
      <SurfacePress
        label={`Project row ${project.name}`}
        selected={selected}
        onPress={onPress}
        c={c}
        corner={radius.control}
        style={{
          gap: space.xxs,
          paddingHorizontal: space.sm,
          paddingVertical: space.sm,
          backgroundColor: "transparent",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minWidth: 0,
          }}
        >
          <ProjectMark badge={model.badge} c={c} />
          <Text
            numberOfLines={1}
            style={{ ...body(c), fontWeight: "600", flex: 1, minWidth: 0 }}
          >
            {project.name}
          </Text>
          {model.age && <Text style={meta(c)}>{model.age}</Text>}
        </View>
        {state.kind === "ready" ? (
          <Text
            numberOfLines={1}
            accessibilityLabel={`Status for ${project.name}: ${[state.attention, state.rest].filter(Boolean).join(" · ")}`}
            style={{ ...body(c), color: r.muted }}
          >
            {state.attention && (
              <Text style={{ color: r.warning }}>{state.attention} · </Text>
            )}
            {state.rest}
          </Text>
        ) : (
          <Text
            accessibilityLabel={`${state.kind === "loading" ? "Loading plan" : "Plan unavailable"} for ${project.name}`}
            accessibilityRole={state.kind === "error" ? "alert" : undefined}
            style={{ ...body(c), color: r.muted }}
          >
            {state.kind === "loading"
              ? "Loading…"
              : `Couldn’t load ${state.subject}: ${state.error}`}
          </Text>
        )}
      </SurfacePress>
      {state.kind === "error" && onRetry && (
        <View style={{ paddingHorizontal: space.sm, paddingBottom: space.xs }}>
          <Button
            small
            c={c}
            text="Retry"
            label={`Retry plan and lane reads for ${project.name}`}
            onPress={onRetry}
          />
        </View>
      )}
    </View>
  );
}

/** The list pane's group header: Active, Idle on purpose, Dormant. */
export function GroupHeader({ title, c }: { title: string; c: Colors }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        ...eyebrow(c),
        paddingHorizontal: space.md + space.xxs,
        paddingTop: space.sm,
        paddingBottom: space.xxs,
      }}
    >
      {title}
    </Text>
  );
}

/** The banner under the roadmap header: the focus, the idle reason or the dormant note. */
function Banner({
  plan,
  lanes,
  group,
  c,
}: {
  plan?: ProjectPlan;
  lanes: LaneView[];
  group: ProjectGroup;
  c: Colors;
}) {
  const r = roles(c);
  const banner = roadmapBanner(plan, lanes, group);
  if (banner.kind === "none") return null;
  if (banner.kind === "focus")
    return (
      <View
        accessibilityLabel="Focus"
        style={{
          gap: space.xxs,
          padding: space.md,
          borderRadius: radius.panel,
          backgroundColor: r.section,
        }}
      >
        <Text style={eyebrow(c)}>Focus</Text>
        <Text
          style={{
            color: r.foreground,
            fontSize: type.section.fontSize,
            lineHeight: type.section.lineHeight,
          }}
        >
          {banner.text}
        </Text>
      </View>
    );
  const idle = banner.kind === "idle";
  return (
    <View
      accessibilityLabel={idle ? "Idle on purpose" : "Dormant"}
      style={{
        gap: space.xxs,
        padding: space.md,
        borderRadius: radius.panel,
        backgroundColor: toneSurface(
          r.warning,
          r.section,
          planningRead.bannerAlpha,
        ),
      }}
    >
      <Text style={{ ...body(c), color: r.warning, fontWeight: "600" }}>
        {idle ? "Idle on purpose" : "Dormant"}
      </Text>
      <Text style={body(c)}>
        {idle
          ? banner.reason
          : "No recent activity and no lane in Now. New work makes it active again."}
      </Text>
    </View>
  );
}

/**
 * History: every saved version of the plan as it was saved, read one at a time through
 * `plan.get` (the latest included, so the live projection of lanes that joined since is
 * never shown as a save). It opens on the latest save and pages back with Earlier and Later.
 * Each version lists its lanes under Now, Next and Later with the note and finish line saved
 * for each. Without the read, the latest save's own membership (`saved`) stands in.
 */
function PlanHistory({
  project,
  latest,
  saved,
  lanes,
  unplanned,
  readPlanVersion,
  c,
}: {
  project: Project;
  latest: ProjectPlan;
  saved?: ProjectPlan;
  lanes: LaneView[];
  unplanned: LaneView[];
  readPlanVersion?: (project: string, version: number) => Promise<ProjectPlan>;
  c: Colors;
}) {
  const r = roles(c);
  // The version on screen belongs to one project: another project starts at its own latest save.
  const [pick, setPick] = useState({
    project: project.key,
    version: latest.version,
  });
  const viewing = pick.project === project.key ? pick.version : latest.version;
  const setViewing = (version: number) =>
    setPick({ project: project.key, version });
  const [read, setRead] = useState<{
    version: number;
    plan?: ProjectPlan;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!viewing || !readPlanVersion) {
      setRead(null);
      return;
    }
    let live = true;
    setRead({ version: viewing });
    readPlanVersion(project.key, viewing).then(
      (plan) => {
        if (live) setRead({ version: viewing, plan });
      },
      (error) => {
        if (live)
          setRead({
            version: viewing,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [viewing, project.key]);
  const isLatest = viewing === latest.version;
  const shown =
    read?.version === viewing && read.plan
      ? read.plan
      : !readPlanVersion && isLatest
        ? (saved ?? { ...latest, entries: [] })
        : undefined;
  const savedLine = (plan: ProjectPlan) =>
    `Version ${plan.version} · saved ${plan.createdAt ? formatLocalDateTime(plan.createdAt) : "at an unknown time"}${plan.author ? ` by ${plan.author}` : ""}`;
  const title = (key: string) =>
    lanes.find((lane) => lane.key === key)?.title ?? key;
  return (
    <View
      accessibilityLabel={`Plan history for ${project.name}`}
      style={{
        gap: space.xs,
        padding: space.sm,
        borderRadius: radius.panel,
        backgroundColor: r.section,
      }}
    >
      {!latest.version ? (
        <Text style={body(c)}>No plan saved yet.</Text>
      ) : shown ? (
        <>
          <Text style={body(c)}>
            {savedLine(shown)}
            {isLatest ? " · the latest" : " · not the latest"}
          </Text>
          {shown.idle && (
            <Text style={meta(c)}>
              Idle on purpose since {formatLocalDateTime(shown.idle.at)}:{" "}
              {shown.idle.reason.replace(/[.!?]+$/, "")}. Saving a changed plan
              or finishing new work ends it.
            </Text>
          )}
          {PLAN_HORIZONS.map((horizon) => {
            const entries = shown.entries.filter(
              (entry) => entry.horizon === horizon,
            );
            return (
              <View
                key={horizon}
                accessibilityLabel={`${horizonTitle(horizon)} in version ${shown.version}`}
                style={{ gap: space.xxs / 2 }}
              >
                <Text style={{ ...meta(c), color: r.foreground }}>
                  {horizonTitle(horizon)}
                  {entries.length ? "" : ": nothing"}
                </Text>
                {entries.map((entry) => (
                  <Text
                    key={entry.lane}
                    style={{ ...meta(c), paddingLeft: space.sm }}
                  >
                    {title(entry.lane)}
                    {entry.doneWhen ? ` · Done when ${entry.doneWhen}` : ""}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </Text>
                ))}
              </View>
            );
          })}
        </>
      ) : read?.error ? (
        <Text
          accessibilityRole="alert"
          style={{ ...body(c), color: r.warning }}
        >
          Couldn’t load version {read.version}: {read.error}
        </Text>
      ) : (
        <Text style={meta(c)}>Loading version {viewing}…</Text>
      )}
      {isLatest && (
        <Text style={meta(c)}>
          {unplanned.length
            ? `${unplanned.length} ${unplanned.length === 1 ? "lane is" : "lanes are"} not in the plan yet: ${unplanned.map((lane) => lane.title).join(", ")}. Edit plan to add ${unplanned.length === 1 ? "it" : "them"}.`
            : "Every lane of this project is in the plan."}
        </Text>
      )}
      {latest.version > 1 && readPlanVersion && (
        <View style={row}>
          <Button
            small
            c={c}
            text="Earlier version"
            label={`Show the earlier version of the ${project.name} plan`}
            disabled={viewing <= 1}
            onPress={() => setViewing(viewing - 1)}
          />
          <Button
            small
            c={c}
            text="Later version"
            label={`Show the later version of the ${project.name} plan`}
            disabled={isLatest}
            onPress={() => setViewing(viewing + 1)}
          />
          <Button
            small
            c={c}
            text="Latest version"
            label={`Show the latest version of the ${project.name} plan`}
            disabled={isLatest}
            onPress={() => setViewing(latest.version)}
          />
        </View>
      )}
    </View>
  );
}

/** What the read view shows for a plan that is loading, failed, or refreshed with an error. */
export type RoadmapSection = {
  project: Project;
  latest?: ProjectPlan;
  /** The latest save's own membership, as stored; `latest` is the live projection. */
  saved?: ProjectPlan;
  triage?: PlanningTriage;
  error?: string;
};

/**
 * One project's plan as a roadmap. Edit plan opens today's editor unchanged; History
 * holds the version, who saved it, and the lanes the plan does not name yet.
 */
export function ProjectRoadmapView({
  section,
  group,
  badge,
  lanes,
  leads,
  width,
  busy,
  onOpenLane,
  onEditPlan,
  onRetry,
  onOpenTask,
  onReopenLane,
  stacked: forceStacked = false,
  readPlanVersion,
  c,
}: {
  section: RoadmapSection;
  group: ProjectGroup;
  badge?: ProjectBadge | null;
  lanes: LaneView[];
  leads: readonly LeadListFacts[];
  /** The pane's measured width; columns stack into one below `planningRead.columnsMin`. 0 is unmeasured. */
  width: number;
  /** Stack the columns whatever the width: the roadmap shares the list pane below 1100 points. */
  stacked?: boolean;
  /** Reads one saved version of the plan, so History can page back through every save. */
  readPlanVersion?: (project: string, version: number) => Promise<ProjectPlan>;
  busy: boolean;
  onOpenLane: (lane: string) => void;
  onEditPlan?: () => void;
  onRetry?: () => void;
  onOpenTask?: (id: string) => void;
  /** Finished lanes reopen through the existing `lane.status`, with no confirmation. */
  onReopenLane?: (lane: string) => void;
  c: Colors;
}) {
  const r = roles(c);
  // History is open for one project at a time, so a newly picked project's opens closed.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const history = historyFor === section.project.key;
  const setHistory = (open: boolean) =>
    setHistoryFor(open ? section.project.key : null);
  const [finished, setFinished] = useState(false);
  const { project, latest, error } = section;
  const name = project.name;
  const scopedLanes = lanes.filter((lane) => !lane.project || lane.project === project.key);
  const roadmap = roadmapView({
    entries: latest?.entries ?? [],
    unplanned: [],
    done: latest?.done,
    lanes: scopedLanes,
    leads,
  });
  const laneFor = (key: string) => scopedLanes.find((lane) => lane.key === key);
  // "Not in the plan yet" is against the latest save as stored: a lane that joined the
  // live projection after it is not planned until a save names it.
  const planned = new Set([
    ...(section.saved?.entries ?? latest?.entries ?? []).map(
      (entry) => entry.lane,
    ),
    ...(latest?.done ?? []).map((entry) => entry.lane),
  ]);
  const unplanned = projectLanes(project, scopedLanes).filter(
    (lane) =>
      !planned.has(lane.key) &&
      (lane.status === "active" || lane.status === "paused"),
  );
  const stacked =
    forceStacked || (width > 0 && width < planningRead.columnsMin);
  const column = (horizon: PlanHorizon) => {
    const steps = roadmap[horizon];
    return (
      <View
        key={horizon}
        accessibilityLabel={`${horizonTitle(horizon)} column`}
        style={{
          // Stacked, each column takes its own height; side by side, they share the width.
          flexGrow: stacked ? 0 : 1,
          flexShrink: stacked ? 0 : 1,
          flexBasis: stacked ? "auto" : 0,
          minWidth: 0,
          gap: space.xs,
        }}
      >
        <View style={{ gap: space.xxs / 2 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <View
              style={{
                width: space.xs,
                height: space.xs,
                borderRadius: radius.full,
                backgroundColor:
                  horizon === "now"
                    ? r.accent
                    : horizon === "next"
                      ? toneSurface(
                          r.accent,
                          r.raised,
                          planningRead.reviewAlpha,
                        )
                      : r.muted,
              }}
            />
            <Text
              accessibilityRole="header"
              style={{ ...body(c), fontWeight: "600" }}
            >
              {horizonTitle(horizon)}
            </Text>
            <Text style={meta(c)}>{steps.length}</Text>
          </View>
          <Text style={meta(c)}>{HORIZON_HINTS[horizon]}</Text>
        </View>
        {steps.map((step) => (
          <LaneCard
            key={step.lane}
            step={step}
            lane={laneFor(step.lane)}
            onOpen={() => onOpenLane(step.lane)}
            c={c}
          />
        ))}
        {!steps.length && (
          <View
            style={{
              padding: space.md,
              borderRadius: radius.panel,
              backgroundColor: roles(c).hover,
              alignItems: "center",
            }}
          >
            <Text style={meta(c)}>Nothing here</Text>
          </View>
        )}
      </View>
    );
  };
  return (
    <View accessibilityLabel={`Plan for ${name}`} style={{ gap: space.lg }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <View style={{ gap: space.xxs, flexShrink: 1, minWidth: 0 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <ProjectMark badge={badge} c={c} />
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
          </View>
          <Text style={{ ...body(c), color: r.muted }}>
            {planUpdatedLine(latest, (at) => decisionAge(at))}
          </Text>
        </View>
        {latest && (
          <View style={row}>
            <Button
              small
              c={c}
              text="History"
              label={`${history ? "Hide" : "Show"} ${name} plan history`}
              selected={history}
              onPress={() => setHistory(!history)}
            />
            {onEditPlan && (
              // Edit is a common action, so it is the edit icon with its name as the tooltip.
              <ActionButton
                c={c}
                action="edit"
                label={`Edit ${name} plan`}
                disabled={busy}
                onPress={onEditPlan}
              />
            )}
          </View>
        )}
      </View>
      {!latest &&
        (error ? (
          <View
            accessibilityRole="alert"
            style={{
              gap: space.xs,
              padding: space.sm,
              borderRadius: radius.control,
              backgroundColor: toneWash(r.danger, r.section),
            }}
          >
            <Text style={body(c)}>Couldn’t load this plan: {error}</Text>
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
          <Text style={{ ...body(c), color: r.muted }}>Loading plan…</Text>
        ))}
      {latest && error && (
        <View
          accessibilityRole="alert"
          style={{
            gap: space.xs,
            padding: space.sm,
            borderRadius: radius.control,
            backgroundColor: toneWash(r.warning, r.section),
          }}
        >
          <Text style={{ ...meta(c), color: r.warning }}>
            The latest plan could not be refreshed: {error}. This may be out of
            date.
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
      {latest && history && (
        <PlanHistory
          key={project.key}
          project={project}
          latest={latest}
          saved={section.saved}
          lanes={scopedLanes}
          unplanned={unplanned}
          readPlanVersion={readPlanVersion}
          c={c}
        />
      )}
      {latest && <Banner plan={latest} lanes={scopedLanes} group={group} c={c} />}
      {!latest && group === "dormant" && (
        <Banner lanes={scopedLanes} group={group} c={c} />
      )}
      {latest && Boolean(latest.entries.length) && (
        <View
          accessibilityLabel="Roadmap"
          style={{
            flexDirection: stacked ? "column" : "row",
            alignItems: stacked ? "stretch" : "flex-start",
            gap: space.md,
          }}
        >
          {PLAN_HORIZONS.map(column)}
        </View>
      )}
      {latest &&
        !latest.entries.length &&
        !latest.idle &&
        group !== "dormant" && (
          <Text style={{ ...body(c), color: r.muted }}>
            {unplanned.length
              ? "No lanes in the plan yet. Edit plan to start one."
              : "No lanes for this project yet."}
          </Text>
        )}
      {roadmap.done.length > 0 && (
        <View
          accessibilityLabel="Finished lanes"
          style={{
            gap: space.xs,
            paddingTop: space.sm,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Finished lanes, ${roadmap.done.length}`}
            accessibilityState={{ expanded: finished }}
            onPress={() => setFinished(!finished)}
          >
            <Text style={{ ...body(c), color: r.muted }}>
              {finished ? "▾" : "▸"} Finished lanes · {roadmap.done.length}
            </Text>
          </Pressable>
          {finished && (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                columnGap: space.md,
                rowGap: space.xxs,
              }}
            >
              {roadmap.done.map((item) => (
                <View
                  key={item.lane}
                  style={{ minWidth: planningRead.finishedMin, gap: space.xxs }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open lane ${item.title}, ${item.status === "done" ? "finished" : "abandoned"}`}
                    onPress={() => onOpenLane(item.lane)}
                  >
                    <Text style={{ ...body(c), color: r.muted }}>
                      {item.status === "done" ? "✓" : "✕"} {item.title}
                      {item.closedAt ? ` · ${item.closedAt.slice(0, 10)}` : ""}
                    </Text>
                  </Pressable>
                  {onReopenLane && (
                    <View style={row}>
                      <Button
                        small
                        c={c}
                        text="Reopen"
                        label={`Reopen lane ${item.title}`}
                        disabled={busy}
                        onPress={() => onReopenLane(item.lane)}
                      />
                      <ReopenHelp c={c} laneTitle={item.title} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
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
