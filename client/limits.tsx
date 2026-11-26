import { useEngineFeatures } from "./engine-features";
import { errorText as failureText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  ActionButton,
  Button,
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
  saveCapacity: (values: api.CapacityInput) => Promise<void>;
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
  high: "High and very-high complexity start on Heavyweight. Frontier profiles require an explicit request. The reviewer runs one bracket below a Heavyweight or Frontier worker, and on the worker's bracket otherwise.",
  extra_high:
    "Starts as at High, and nothing needs permission. The reviewer runs on the worker's bracket.",
  maximum:
    "Low complexity starts on Worker, medium and high on Heavyweight, very high on Frontier. A high task may step up to Frontier after review changes, and nothing needs permission. The reviewer runs on the worker's bracket.",
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

/** The two dispatch limits exposed by the Rust board. */
const CAPACITY_FIELDS = [
  { key: "globalLimit", label: "Global", max: 64 },
  { key: "projectLimit", label: "Per project", max: 32 },
] as const;
type CapacityKey = (typeof CAPACITY_FIELDS)[number]["key"];
type LimitSpec = (typeof CAPACITY_FIELDS)[number];

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

/** The global and per-project task slots. */
function TaskSlots({
  c,
  values,
  revision,
  authorityError,
  retry,
  save,
}: {
  c: Colors;
  values: api.CapacityAuthorityValues | null;
  revision?: string;
  authorityError: unknown;
  retry: () => void;
  save: (values: api.CapacityInput) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<CapacityKey, number>>>(
    {},
  );
  // Coalesce only the fields edited during this debounce, against their displayed revision.
  const pending = useRef<{ revision?: string; fields: Partial<Record<CapacityKey, number>> }>({ fields: {} });
  const auto = useSectionAutoSave<api.CapacityInput>(async (input) => {
    pending.current = { fields: {} };
    try {
      await save(input);
    } catch (error) {
      if ("revision" in input) retry();
      throw error;
    } finally {
      setDrafts(pending.current.fields);
    }
  });
  const edit = (key: CapacityKey, value: number) => {
    if (!values) return;
    const fields = { ...pending.current.fields, [key]: value };
    const base = pending.current.revision ?? revision;
    pending.current = { revision: base, fields };
    setDrafts(fields);
    auto.enqueue(base === undefined ? { ...values, ...fields } : { revision: base, ...fields }, 600);
  };
  // A labelled card per limit. The line under it names the value in force only when the
  // entered value differs, so an unsaved draft never reads as applied.
  const field = (spec: LimitSpec, current: api.CapacityAuthorityValues) => {
    const name = spec.label;
    const max = revision !== undefined && spec.key === "globalLimit" ? api.MAX_GLOBAL_SLOTS : spec.max;
    const draft = drafts[spec.key] ?? current[spec.key];
    return (
      <NumberStepper
        key={spec.key}
        card
        c={c}
        label={name}
        a11yLabel={`${name} dispatch limit (slots, 1–${max})`}
        value={draft}
        min={1}
        max={max}
        onChange={(value) => edit(spec.key, value)}
        onCommit={() => void auto.saver.flush()}
      >
        {draft !== current[spec.key] && (
          <Text style={small(c)}>
            In force {current[spec.key]} slots
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
      description="Parked tasks hold no slot. Lowering a limit lets running work finish."
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
            {CAPACITY_FIELDS.map((spec) => field(spec, values))}
          </View>
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
  const features = useEngineFeatures();
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
      title={features.projectDefaultLimit ? "Project overrides" : "Project slots"}
      last
      description={
        features.projectDefaultLimit
          ? "Slots run 0–64, where 0 admits nothing. A project may have twice its slots in flight. A project without an override uses the per-project limit."
          : "Each project's own slot limit, at least 1."
      }
      action={
        features.projectDefaultLimit && <DropdownSelect
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
            removable={features.projectDefaultLimit}
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
  removable = true,
  save,
}: {
  c: Colors;
  projectName: string;
  value: number;
  canSave: boolean;
  pendingRemoval?: PendingOverrideRemovalPhase;
  /** False when the slot limit belongs to the project and cannot be removed. */
  removable?: boolean;
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
        {removable && <ActionButton
          c={c}
          action="remove"
          label={`Remove the ${projectName} override`}
          disabled={removing || confirming}
          onPress={() => setConfirming(true)}
        />}
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
        revision={authority?.revision}
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
