import { errorText as failureText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "./shell";
import {
  ActionButton,
  Button,
  Disclosure,
  DropdownSelect,
  HelpPopover,
  HelpTip,
  InlineConfirm,
  NumberStepper,
  SaveStatus,
  Section,
  StopSlider,
  muted,
  row,
  useSectionAutoSave,
  type Colors,
} from "./controls";
import { radius, roles, space, type } from "./design";
import { DateTimeLink, formatLocalDateTime } from "./date-time-field";
import { USAGE_LABELS } from "../shared/pool";
import * as api from "../shared/contracts";
import {
  MAX_HOLD_MINUTES,
  MAX_HOST_OUTAGE_NOTICE_MINUTES,
  MAX_HOST_CALL_LIMIT,
  MAX_STALL_THRESHOLD_MINUTES,
  MAX_THREAD_RETENTION_DAYS,
  usageLevels,
  type UiQueueState,
  type UsageLevel,
} from "../shared/contracts";

/*
 * Settings → Dispatch limits. One place for what the host runs with: the usage
 * level, the task slots, project overrides.
 * Every limit reads as its value in force when that
 * differs from what is entered. The RPCs and their authority are unchanged; this
 * module only changes how they read (Tom, 2026-11-08: half the height, same controls).
 */

/** A project override write: its slot limit, or null to remove it. The in-flight cap is always twice the slots (Tom, 2026-11-08). */
export type ProjectLimitPatch = { projectKey?: string; limit: number | null };

/** In-flight removal phase for a project slot override, retained across Settings tab switches. */
export type PendingOverrideRemovalPhase = "saving" | "refreshing";

export type DispatchLimitsProps = {
  c: Colors;
  state: UiQueueState;
  busy: boolean;
  /** `queue.capacity-state`, read on its own. Undefined until the first read settles. */
  authority: api.CapacityAuthorityState | undefined;
  authorityError: unknown;
  retryAuthority: () => void;
  refreshBoard: () => Promise<unknown>;
  saveUsage: (level: UsageLevel, until: string | null) => Promise<void>;
  saveCapacity: (values: api.CapacityAuthorityValues) => Promise<void>;
  saveProjectLimit: (
    value: ProjectLimitPatch & { projectKey: string },
  ) => Promise<void>;
  /** Override removals currently saving or refreshing, keyed by project key. */
  pendingOverrideRemovals?: Readonly<
    Record<string, PendingOverrideRemovalPhase>
  >;
};

const small = (c: Colors) => ({
  ...muted(c),
  fontSize: type.metadata.fontSize,
  lineHeight: type.metadata.lineHeight,
});

/**
 * One grant on one full-width row (Tom, 2026-11-08): the planner, its profiles, the (?)
 * holding reason, since, until and run count, and Revoke as an icon button that asks first.
 */
/**
 * Spec 052 (Tom, 2026-11-19): what each level does to a task's start bracket and
 * which profiles require a request. The full sentence sits behind the
 * slider's (?).
 */
const USAGE_EFFECT: Record<UsageLevel, string> = {
  low: "Every task starts one bracket below the one it may climb to. High and very-high complexity work needs permission when it is submitted. Frontier requires an explicit profile request. The reviewer runs one bracket below the worker.",
  normal:
    "Low complexity runs on Mechanical, medium and high on Worker, very high on Heavyweight. A high task may step up to Heavyweight after review changes; Frontier requires an explicit profile request. The reviewer runs one bracket below the worker.",
  high: "High and very-high complexity start on Heavyweight. Frontier profiles require an explicit request. The reviewer runs on the worker's bracket.",
  extra_high:
    "Starts as at High, and nothing needs permission. The reviewer runs on the worker's bracket.",
  maximum:
    "Workers and reviewers run on Heavyweight or Frontier regardless of complexity, and nothing needs permission.",
};

/** The levels that can carry an end time: above Normal, where returning to Normal means something. */
const LIFTED: ReadonlySet<UsageLevel> = new Set([
  "high",
  "extra_high",
  "maximum",
]);

/**
 * Spec 052: the operator's overall usage level as a five-stop slider. What a level does sits behind the (?).
 * At High and Maximum, an end time sits as small text on the heading row's right, so the slider keeps
 * its full width (Tom, 2026-11-09); it opens the date picker and returns the level to Normal when reached.
 */
function UsageSlider({
  c,
  usage,
  save,
}: {
  c: Colors;
  usage: UiQueueState["usage"];
  save: (level: UsageLevel, until: string | null) => Promise<void>;
}) {
  const [level, setLevelDraft] = useState<UsageLevel>(usage.level);
  const [until, setUntilDraft] = useState<string | null>(
    usage.expired ? null : usage.until,
  );
  const auto = useSectionAutoSave<{ level: UsageLevel; until: string | null }>(
    (value) => save(value.level, value.until),
  );
  // A level with no end-time control carries no end time: a hidden date would be one nobody can see or clear.
  const setLevel = (next: UsageLevel) => {
    const nextUntil = LIFTED.has(next) ? until : null;
    setLevelDraft(next);
    setUntilDraft(nextUntil);
    auto.enqueue({ level: next, until: nextUntil });
  };
  const setUntil = (next: string | null) => {
    setUntilDraft(next);
    auto.enqueue({ level, until: next });
  };
  // The board's value is adopted whenever nothing is pending and the last save did
  // not fail, so an open picker and an unsaved draft survive re-projections.
  useEffect(() => {
    if (auto.saver.busy || auto.failed) return;
    setLevelDraft(usage.level);
    setUntilDraft(usage.expired ? null : usage.until);
  }, [usage.level, usage.until, usage.expired, auto.failed]);
  // Normal in force shows only when it differs from the level set: an ended level has returned to Normal.
  const note = usage.expired ? "Normal in force" : undefined;
  const end = LIFTED.has(level) ? (
    <View
      style={{
        marginLeft: "auto",
        flexShrink: 1,
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <DateTimeLink
        c={c}
        label="Return to Normal"
        prefix="until "
        emptyText="No end"
        value={until}
        onChange={setUntil}
      />
    </View>
  ) : undefined;
  return (
    <Section
      c={c}
      title="Usage level"
      label="Usage level"
      note={note}
      status={auto.status}
      action={end}
      description={`${USAGE_EFFECT[level]} Above Normal, the end time returns the level to Normal when it is reached.`}
    >
      <StopSlider
        c={c}
        a11yLabel="Usage level"
        stops={usageLevels}
        value={level}
        labelFor={(stop) => USAGE_LABELS[stop].label}
        stopLabel={(stop) => `Usage ${USAGE_LABELS[stop].label}`}
        onChange={setLevel}
      />
    </Section>
  );
}

/* ------------------------------------------------------------------------- */
/* Settings-only capacity writes: the limits and their reads                 */
/* ------------------------------------------------------------------------- */

/*
 * Settings-only capacity writes (service-boundary contract, "Settings-only capacity
 * writes"): Settings is the only route that changes the host's dispatch limits, and
 * every applied change is recorded with its time, surface and the full values before
 * and after. The CLI and every agent route refuse, so a field saves on its own. The
 * record is read through `queue.capacity-state`; Settings shows no view of it (Tom, 2026-11-08).
 */

/**
 * Every limit, in the shared schema's own order and bounds; the schema still refuses
 * anything else. The first three are the ordinary task slots; the rest sit under Advanced.
 */
const CAPACITY_FIELD_LABELS: Record<keyof api.CapacityAuthorityValues, string> =
  {
    globalLimit: "Global",
    projectLimit: "Per project",
    papercutProjectLimit: "Papercuts",
    hostCallLimit: "Concurrent host calls",
    stallThresholdMinutes: "Stall threshold",
    holdReminderMinutes: "Hold reminder",
    holdEscalationMinutes: "Hold escalation",
    laneDrainMinutes: "Lane drain",
    laneDrainEscalationMinutes: "Lane drain escalation",
    hostOutageNoticeMinutes: "Host outage notice",
    operatorDefaultHostKind: "Default host",
    threadRetentionDays: "Archived thread retention",
  };
type CapacityKey = Exclude<
  keyof api.CapacityAuthorityValues,
  "operatorDefaultHostKind"
>;
type LimitSpec = {
  key: CapacityKey;
  min: number;
  max: number;
  unit: "slots" | "calls" | "minutes" | "days";
  advanced?: true;
  /** Explained under a (?) beside the label, for a limit whose meaning the label cannot carry. */
  help?: string;
};
const CAPACITY_FIELDS: LimitSpec[] = [
  { key: "globalLimit", min: 1, max: 64, unit: "slots" },
  { key: "projectLimit", min: 1, max: 32, unit: "slots" },
  { key: "papercutProjectLimit", min: 1, max: 32, unit: "slots" },
  {
    key: "hostCallLimit",
    min: 1,
    max: MAX_HOST_CALL_LIMIT,
    unit: "calls",
    advanced: true,
    help: "A ceiling for each host, not a total across hosts: Paseo, T3 Code and BB each run up to this many calls at once, and each keeps its own count.",
  },
  {
    key: "stallThresholdMinutes",
    min: 1,
    max: MAX_STALL_THRESHOLD_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "holdReminderMinutes",
    min: 1,
    max: MAX_HOLD_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "holdEscalationMinutes",
    min: 1,
    max: MAX_HOLD_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "laneDrainMinutes",
    min: 1,
    max: MAX_HOLD_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "laneDrainEscalationMinutes",
    min: 1,
    max: MAX_HOLD_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "hostOutageNoticeMinutes",
    min: 1,
    max: MAX_HOST_OUTAGE_NOTICE_MINUTES,
    unit: "minutes",
    advanced: true,
  },
  {
    key: "threadRetentionDays",
    min: 1,
    max: MAX_THREAD_RETENTION_DAYS,
    unit: "days",
    advanced: true,
  },
];
const UNIT_SHORT: Record<LimitSpec["unit"], string> = {
  slots: "slots",
  calls: "calls",
  minutes: "min",
  days: "days",
};

/** A limits read that has not settled: loading, a failed first read, or a failed refresh. Nothing here writes, so Try again is always safe. */
function ReadNotice({
  c,
  hasValues,
  error,
  retry,
}: {
  c: Colors;
  hasValues: boolean;
  error: unknown;
  retry: () => void;
}) {
  if (!error)
    return hasValues ? null : (
      <Text accessibilityLiveRegion="polite" style={muted(c)}>
        Reading the dispatch limits…
      </Text>
    );
  return (
    <View style={{ gap: space.xs }}>
      <Text
        accessibilityRole="alert"
        style={{
          color: roles(c).warning,
          fontSize: type.body.fontSize,
          lineHeight: type.body.lineHeight,
        }}
      >
        {hasValues
          ? "Couldn't refresh the dispatch limits. The values shown may be out of date; nothing was changed."
          : "Couldn't read the dispatch limits, so none is shown as applied. Nothing was changed."}
      </Text>
      <Text style={small(c)}>{failureText(error)}</Text>
      <View style={row}>
        <Button
          small
          c={c}
          text="Retry"
          label="Retry reading the dispatch limits"
          onPress={retry}
        />
      </View>
    </View>
  );
}

/** The task slots: the three ordinary limits first, the six timing and call limits under Advanced. */
function TaskSlots({
  c,
  values,
  authorityError,
  retry,
  save,
}: {
  c: Colors;
  values: api.CapacityAuthorityValues | null;
  authorityError: unknown;
  retry: () => void;
  save: (values: api.CapacityAuthorityValues) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<CapacityKey, number>>>(
    {},
  );
  // Local UI state: opening Advanced never writes, and collapsing keeps every draft and pending save.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const auto = useSectionAutoSave(save);
  // The applied values are adopted whenever nothing is pending and the last save did
  // not fail, so a refresh (or a change made elsewhere) never fights a live draft.
  const valuesJson = values ? JSON.stringify(values) : "";
  useEffect(() => {
    if (!values || auto.saver.busy || auto.failed) return;
    setDrafts(
      Object.fromEntries(
        CAPACITY_FIELDS.map((field) => [field.key, values[field.key]]),
      ),
    );
  }, [valuesJson, auto.failed]);
  // The control keeps each value in its range, so every edit is sendable. Typing saves
  // after a pause and a step after the same pause, so repeated presses land as one save.
  // One field at a time still writes the whole state, so a change never carries a stale
  // value for a limit it did not touch.
  const edit = (key: CapacityKey, value: number) => {
    const next = { ...drafts, [key]: value };
    setDrafts(next);
    if (!values) return;
    auto.enqueue(
      Object.fromEntries(
        CAPACITY_FIELDS.map((field) => [
          field.key,
          next[field.key] ?? values[field.key],
        ]),
      ) as unknown as api.CapacityAuthorityValues,
      600,
    );
  };
  // A labelled card per limit. The line under it names the value in force only when the
  // entered value differs, so an unsaved draft never reads as applied.
  const field = (spec: LimitSpec, current: api.CapacityAuthorityValues) => {
    const name = CAPACITY_FIELD_LABELS[spec.key],
      unit = UNIT_SHORT[spec.unit];
    const draft = drafts[spec.key] ?? current[spec.key];
    return (
      <NumberStepper
        key={spec.key}
        card
        stacked={spec.advanced}
        c={c}
        label={name}
        help={spec.help}
        a11yLabel={`${name} dispatch limit (${spec.unit}, ${spec.min}–${spec.max})`}
        value={draft}
        min={spec.min}
        max={spec.max}
        unit={spec.unit === "slots" ? undefined : unit}
        onChange={(value) => edit(spec.key, value)}
        onCommit={() => void auto.saver.flush()}
      >
        {draft !== current[spec.key] && (
          <Text style={small(c)}>
            In force {current[spec.key]} {unit}
          </Text>
        )}
      </NumberStepper>
    );
  };
  return (
    <Section
      c={c}
      title="Task slots"
      status={auto.status}
      description="Only Settings changes these. Parked tasks hold no slot, lowering a limit lets running work finish, and papercuts also count toward Global."
    >
      <ReadNotice
        c={c}
        hasValues={Boolean(values)}
        error={authorityError}
        retry={retry}
      />
      {values && (
        <>
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
          >
            {CAPACITY_FIELDS.filter((spec) => !spec.advanced).map((spec) =>
              field(spec, values),
            )}
          </View>
          <Disclosure
            c={c}
            gapAbove
            label="Advanced limits"
            expanded={advancedOpen}
            onToggle={() => setAdvancedOpen((open) => !open)}
          />
          {advancedOpen && (
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
            >
              {CAPACITY_FIELDS.filter((spec) => spec.advanced).map((spec) =>
                field(spec, values),
              )}
            </View>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Project overrides, one line each (Tom, 2026-11-08): the project, its slot limit and a
 * trash icon that asks first. The slot limit is the server's effective value
 * (`projectCapacities`); its in-flight cap is always twice that, so it has no control.
 * Only Settings' + picker creates an override.
 */
function ProjectOverrides({
  c,
  state,
  busy,
  saveProjectLimit,
  pendingOverrideRemovals,
}: {
  c: Colors;
  state: UiQueueState;
  busy: boolean;
  saveProjectLimit: (
    value: ProjectLimitPatch & { projectKey: string },
  ) => Promise<void>;
  pendingOverrideRemovals?: Readonly<
    Record<string, PendingOverrideRemovalPhase>
  >;
}) {
  // Choosing a project creates its override at once with the per-project limit;
  // a failure to create it is shown here, beside the picker.
  const [addStatus, setAddStatus] = useState("");
  // One create at a time: + and the picker wait for it, so a second pick can
  // never overwrite an edit made after the first (review #596).
  const [creating, setCreating] = useState<string | null>(null);
  const overrides = state.projectLimitOverrides ?? {};
  const effective = new Map(
    (state.projectCapacities ?? []).map((entry) => [entry.projectKey, entry]),
  );
  const configuredProjects = Object.keys(overrides);
  const availableProjects = state.projects.filter(
    (project) =>
      !Object.prototype.hasOwnProperty.call(overrides, project.key) &&
      project.key !== creating,
  );
  // The key tells two projects with one name apart; it shows nowhere else.
  const pickerLabel = (project: UiQueueState["projects"][number]) =>
    state.projects.filter((other) => other.name === project.name).length > 1
      ? `${project.name} · ${project.key}`
      : project.name;
  // A simple choice opens as the anchored section menu, never a full-screen
  // dialog: picking a project creates its override at once (task 923).
  const chooseProject = (projectKey: string) => {
    const projectRecord = availableProjects.find(
      (candidate) => candidate.key === projectKey,
    );
    if (!projectRecord) return;
    setAddStatus("Saving…");
    setCreating(projectRecord.key);
    void saveProjectLimit({
      projectKey: projectRecord.key,
      limit: state.projectLimit,
    })
      .then(
        () => setAddStatus(""),
        (error) => setAddStatus(`Not saved: ${failureText(error)}`),
      )
      .finally(() => setCreating(null));
  };
  return (
    <Section
      c={c}
      title="Project overrides"
      last
      description="Slots run 0–64, where 0 admits nothing. A project may have twice its slots in flight. A project without an override uses the per-project limit."
      action={
        <DropdownSelect
          compact
          label="Add project limit override"
          value=""
          placeholder="+"
          disabled={busy || Boolean(creating) || !availableProjects.length}
          emptyText="Every project already has an override."
          options={availableProjects.map((projectRecord) => ({
            value: projectRecord.key,
            label: pickerLabel(projectRecord),
          }))}
          onChange={chooseProject}
          c={c}
          minWidth={52}
        />
      }
    >
      {!configuredProjects.length && (
        <Text style={muted(c)}>
          None. Every project uses the per-project limit.
        </Text>
      )}
      {addStatus && (
        <SaveStatus c={c} status={addStatus} label="Project override" />
      )}
      {configuredProjects.sort().map((projectKey) => {
        const projectRecord = state.projects.find(
          (project) => project.key === projectKey,
        );
        const limit =
          effective.get(projectKey)?.slotLimit ?? overrides[projectKey];
        return (
          <ProjectLimitRow
            key={projectKey}
            c={c}
            projectName={projectRecord?.name ?? projectKey}
            value={limit}
            canSave={Boolean(projectRecord)}
            pendingRemoval={pendingOverrideRemovals?.[projectKey]}
            save={(next) => saveProjectLimit({ projectKey, ...next })}
          />
        );
      })}
    </Section>
  );
}

function ProjectLimitRow({
  c,
  projectName,
  value,
  canSave,
  pendingRemoval,
  save,
}: {
  c: Colors;
  projectName: string;
  value: number;
  canSave: boolean;
  pendingRemoval?: PendingOverrideRemovalPhase;
  save: (patch: ProjectLimitPatch) => Promise<void>;
}) {
  const [limit, setLimit] = useState(value);
  // Edits and removals (null) share one ordered queue: a removal replaces any pending
  // edit and runs after one already in flight, so it is never overtaken.
  const auto = useSectionAutoSave(save);
  useEffect(() => {
    if (!auto.saver.busy && !auto.failed) setLimit(value);
  }, [value, auto.failed]);
  // Once a removal starts the row takes no edits, so nothing pending can recreate the
  // override when it unmounts; a failed removal gives editing back. Parent-tracked
  // `pendingRemoval` preserves this lock across Settings tab switches (nucleus#1495).
  const [localRemoving, setLocalRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (localRemoving && auto.failed) setLocalRemoving(false);
  }, [localRemoving, auto.failed]);
  const removing = localRemoving || Boolean(pendingRemoval);
  const removalStatus =
    pendingRemoval === "refreshing"
      ? "Removed — refreshing…"
      : removing
        ? "Removing…"
        : "";
  const change = (next: number) => {
    if (removing) return;
    setLimit(next);
    if (canSave) auto.enqueue({ limit: next }, 600);
  };
  const remove = () => {
    setConfirming(false);
    setLocalRemoving(true);
    auto.enqueue({ limit: null });
  };
  return (
    <View
      accessibilityLabel={`${projectName} override`}
      style={{
        gap: space.xs,
        paddingVertical: space.xxs,
        paddingLeft: space.sm,
        paddingRight: space.xxs,
        borderRadius: radius.card,
        backgroundColor: roles(c).section,
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
      >
        <Text
          style={{
            color: roles(c).foreground,
            fontWeight: "600",
            fontSize: type.body.fontSize,
            lineHeight: type.body.lineHeight,
            flex: 1,
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {projectName}
        </Text>
        {removalStatus ? (
          <Text
            accessibilityLabel={`${projectName} override save status`}
            accessibilityLiveRegion="polite"
            style={{
              ...muted(c),
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
              flexShrink: 1,
              maxWidth: "100%",
              textAlign: "right",
            }}
          >
            {removalStatus}
          </Text>
        ) : (
          <SaveStatus
            c={c}
            status={auto.status}
            label={`${projectName} override`}
          />
        )}
        <NumberStepper
          c={c}
          a11yLabel={`Task slots for ${projectName} (0–64; 0 admits nothing)`}
          value={limit}
          min={0}
          max={64}
          disabled={removing || !canSave}
          onChange={change}
          onCommit={() => void auto.saver.flush()}
        />
        <ActionButton
          c={c}
          action="remove"
          label={`Remove the ${projectName} override`}
          disabled={removing || confirming}
          onPress={() => setConfirming(true)}
        />
      </View>
      {!canSave && (
        <Text
          style={{
            color: roles(c).warning,
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
          }}
        >
          This project is no longer available. Remove its override to clear it.
        </Text>
      )}
      {confirming && (
        <InlineConfirm
          c={c}
          question="Remove this override?"
          confirmLabel="Remove"
          label={`${projectName} dispatch limit override`}
          busy={removing}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </View>
  );
}

/**
 * Settings → Dispatch limits, in the order the operator reads it: usage level, task
 * slots, project overrides.
 */
export function DispatchLimits(props: DispatchLimitsProps) {
  const { c, state, authority } = props;
  const values = authority?.effective ?? null;
  return (
    <View>
      <UsageSlider c={c} usage={state.usage} save={props.saveUsage} />
      <TaskSlots
        c={c}
        values={values}
        authorityError={props.authorityError}
        retry={props.retryAuthority}
        save={props.saveCapacity}
      />
      <ProjectOverrides
        c={c}
        state={state}
        busy={props.busy}
        saveProjectLimit={props.saveProjectLimit}
        pendingOverrideRemovals={props.pendingOverrideRemovals}
      />
    </View>
  );
}
