import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "./shell";
import { useEngineFeatures } from "./engine-features";
import * as api from "../shared/contracts";
import {
  ActionButton,
  Button,
  StatusGlyph,
  Disclosure,
  DropdownSelect,
  Field,
  FieldCaption,
  HoverRow,
  StopSlider,
  controlText,
  muted,
  popover,
  row,
  type Colors,
} from "./controls";
import {
  control,
  roles,
  space,
  type as typeScale,
  radius,
  usageStripColor,
} from "./design";
import { Popover } from "./popover";
import { createAutoSave, type AutoSave } from "../shared/autosave";
import {
  hostModelFor,
  profileAvailability,
  type NucleusProfile,
} from "../shared/profiles";
import { BRACKET_LABELS, PROFILE_CAPABILITY_LEVELS } from "../shared/pool";
import {
  RUNTIME_MODES,
  RUNTIME_MODE_LABELS,
  THINKING_LABELS,
  THINKING_LEVELS,
} from "../shared/profile-vocabulary";
import type {
  HostCatalog,
  HostFeature,
  HostModel,
  HostProvider,
} from "../shared/host";
import type {
  PoolEntry,
  Profile,
  Project,
  RepositorySettings,
  UiQueueState,
} from "../shared/contracts";
import {
  WEIGHT_STOP_LABELS,
  WEIGHT_STOP_SPEECH,
  HOST_DEFAULT,
  PAIRED_MIN_WIDTH,
  USAGE_ROLE_TABS,
  defaultPoolEntry,
  emptyProfileDraft,
  featureFingerprint,
  hostCompatibilityNote,
  identityCreateInput,
  hiddenThinkingValues,
  identityValid,
  profileUsage,
  withCanonicalOption,
  levelLabel,
  modelWords,
  namedProvider,
  plainWords,
  profileDraft,
  profileRowStatus,
  projectNameForPath,
  providerOptionLabel,
  type CatalogRead,
  type CompatibilityRead,
  type ProfileDraft,
  type UsageRole,
} from "./settings-profile-helpers";

/**
 * One profile row's recent-assignment usage for the selected view (nucleus#1502): the
 * track fills the existing control height and scales to the busiest profile in the
 * rendered list. The color is a secondary cool-to-warm cue; length carries the
 * comparison. Hover or focus shows the same count, sample and view as a tooltip, and
 * the accessible label names them for readers.
 */
function ProfileUsageBar({
  c,
  name,
  count,
  max,
  sample,
  role,
}: {
  c: Colors;
  name: string;
  count: number;
  max: number;
  sample: number;
  role: UsageRole;
}) {
  const [showHint, setShowHint] = useState(false);
  const anchor = useRef<View | null>(null);
  const ratio = max > 0 ? Math.max(0, Math.min(1, count / max)) : 0;
  const percent = ratio * 100;
  const color = usageStripColor(ratio);
  const scope = (
    USAGE_ROLE_TABS.find((tab) => tab.id === role)?.label ?? "All roles"
  ).toLowerCase();
  const summary = `${name}, ${scope}: ${count} of ${sample} recent assignments`;
  return (
    <Pressable
      ref={anchor}
      accessibilityRole="image"
      accessibilityLabel={summary}
      onPress={() => setShowHint((open) => !open)}
      onHoverIn={() => setShowHint(true)}
      onHoverOut={() => setShowHint(false)}
      onFocus={() => setShowHint(true)}
      onBlur={() => setShowHint(false)}
      style={{
        flex: 1,
        minWidth: 56,
        maxWidth: 240,
        height: control.height,
      }}
    >
      <View
        style={{
          flex: 1,
          height: control.height,
          borderRadius: radius.control,
          backgroundColor: c.border,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: "100%",
            backgroundColor: color,
          }}
        />
      </View>
      {showHint && (
        <Popover
          anchor={anchor}
          align="end"
          pointerEvents="none"
          maxWidth={320}
          inlineStyle={{
            top: control.height + space.xxs,
            right: 0,
            maxWidth: 320,
          }}
        >
          <View
            pointerEvents="none"
            style={{
              paddingHorizontal: space.xs,
              paddingVertical: space.xxs,
              borderRadius: radius.control,
              ...popover(c),
            }}
          >
            <Text
              style={{
                color: roles(c).foreground,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              {summary}
            </Text>
          </View>
        </Popover>
      )}
    </Pressable>
  );
}

export function ProfileRow({
  c,
  profile,
  board,
  stored,
  compatibility,
  catalog,
  catalogs,
  directory,
  projects,
  repositories,
  state,
  visibleProfileIds,
  usageRole,
  usageReady = true,
  busy,
  canEdit = true,
  editing,
  poolSave,
  actionStatus,
  onEdit,
  onCreated,
  onDuplicate,
  onRemove,
  onChooseDirectory,
}: {
  c: Colors;
  profile: NucleusProfile | Profile;
  board: Profile | null;
  stored: NucleusProfile | null;
  compatibility: CompatibilityRead | undefined;
  catalog: HostCatalog | undefined;
  catalogs: CatalogRead[];
  directory: string | null;
  projects: readonly Project[];
  repositories: readonly RepositorySettings[];
  state: UiQueueState | null;
  visibleProfileIds: readonly string[];
  usageRole: UsageRole;
  usageReady?: boolean;
  busy: boolean;
  canEdit?: boolean;
  editing: boolean;
  poolSave: (entry: PoolEntry, groupChanged?: boolean) => Promise<void>;
  actionStatus: string;
  onEdit: () => void;
  onCreated: (profile: NucleusProfile) => void;
  onDuplicate: () => void;
  onRemove: () => Promise<void>;
  onChooseDirectory: (cwd: string) => void;
}) {
  const rust = useEngineFeatures().engine === "rust";
  const storedEntry = state?.pool.find((entry) => entry.profileId === profile.id);
  const original = storedEntry ?? (rust ? null : defaultPoolEntry(profile));
  const [entry, setEntry] = useState(original),
    [saveStatus, setSaveStatus] = useState("");
  const mounted = useRef(true),
    saveRef = useRef(poolSave),
    entryRef = useRef(entry),
    savedGroup = useRef(original?.group);
  saveRef.current = poolSave;
  const saver = useRef<AutoSave<PoolEntry> | null>(null);
  if (!saver.current)
    saver.current = createAutoSave(
      async (value) => {
        const group = value.group.trim();
        await saveRef.current(value, group !== savedGroup.current);
        savedGroup.current = group;
      },
      (status) => {
        if (mounted.current)
          setSaveStatus(
            entryRef.current?.group.trim() ? status : "Subscription is required",
          );
      },
    );
  const originalJson = JSON.stringify(original);
  useEffect(() => {
    if (
      !saver.current!.busy &&
      !saveStatus.startsWith("Not saved") &&
      saveStatus !== "Subscription is required"
    ) {
      setEntry(original);
      entryRef.current = original;
      savedGroup.current = original?.group;
    }
  }, [originalJson]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void saver.current!.flush();
    };
  }, []);
  function change(patch: Partial<PoolEntry>, delay = 0) {
    if (!entryRef.current) return;
    const next = { ...entryRef.current, ...patch };
    entryRef.current = next;
    setEntry(next);
    if (!next.group.trim()) {
      saver.current!.cancelPending();
      setSaveStatus("Subscription is required");
      return;
    }
    saver.current!.enqueue(next, delay);
  }
  const availability =
    stored && catalog
      ? { ...stored, ...profileAvailability(stored, catalog) }
      : (board ?? {
          ...profile,
          available: true,
          problem: "",
          supportedThinking: [] as string[],
        });
  const status = state && entry
    ? profileRowStatus(availability, entry, state)
    : { problem: "" };
  const usage = profileUsage(usageReady ? state : null, profile.id, visibleProfileIds, usageRole);
  const hostNote = hostCompatibilityNote(compatibility, profile.id);
  const attention = status.problem
    ? `${status.problem}${hostNote ? `\n${hostNote}` : ""}`
    : hostNote;
  return (
    <View
      style={{
        paddingVertical: space.xs,
        gap: space.xs,
      }}
    >
      <HoverRow c={c}>
        <View style={{ ...row, flexWrap: "nowrap" }}>
          <Text
            style={{
              flex: 1,
              minWidth: 0,
              color: c.foreground,
              fontWeight: "600",
              fontSize: typeScale.body.fontSize,
            }}
          >
            {profile.name}
          </Text>
          {usage ? (
            <ProfileUsageBar
              c={c}
              name={profile.name}
              count={usage.count}
              max={usage.max}
              sample={usage.sample}
              role={usageRole}
            />
          ) : null}
          {attention ? (
            <StatusGlyph
              c={c}
              icon="TriangleAlert"
              color={c.statusWarning}
              text={attention}
              label={`${profile.name}: ${attention.split("\n")[0]}`}
            />
          ) : null}
          {entry && (
            <Button
              matchField
              c={c}
              text={entry.enabled ? "On" : "Off"}
              selected={entry.enabled}
              disabled={!canEdit || busy || !state || (rust && !storedEntry)}
              label={canEdit
                ? `${entry.enabled ? "Disable" : "Enable"} ${profile.name}`
                : `${profile.name}: ${entry.enabled ? "On" : "Off"}`}
              onPress={() => change({ enabled: !entry.enabled })}
            />
          )}
          {canEdit && (
            <ActionButton
              c={c}
              action={editing ? "close" : "edit"}
              label={`${editing ? "Close" : "Edit"} ${profile.name}`}
              onPress={() => {
                void saver.current!.flush();
                onEdit();
              }}
            />
          )}
        </View>
      </HoverRow>
      {canEdit && editing && (
        <ProfileEditor
          c={c}
          catalog={catalog}
          catalogs={catalogs}
          directory={directory}
          projects={projects}
          repositories={repositories}
          initial={profile}
          entry={state ? entry : null}
          state={state}
          busy={busy}
          poolSaveStatus={saveStatus}
          actionStatus={actionStatus}
          onChangePool={state && entry ? change : undefined}
          onFlushPool={() => void saver.current!.flush()}
          onCreated={onCreated}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
          onChooseDirectory={onChooseDirectory}
        />
      )}
    </View>
  );
}

export function quietSaveStatus(status: string) {
  if (
    status === "Saved" ||
    status.startsWith("Not saved") ||
    status === "Subscription is required" ||
    status === "A name, a provider and a model are needed."
  )
    return status;
  return "";
}

/**
 * Create or edit one stored profile in Nucleus's canonical vocabulary, offering
 * what at least one registered host can run (task 1158). Provider, model,
 * mode and thinking are dropdowns; a list that is only Host default is plain
 * text. Changes save on entry (Tom, 2026-11-08): text after a short pause,
 * choices at once. There is no Save or Cancel. Notes stay stored and unshown.
 */
export function ProfileEditor({
  c,
  catalog,
  catalogs,
  directory,
  projects,
  repositories,
  initial,
  entry,
  state,
  busy,
  poolSaveStatus,
  actionStatus,
  onChangePool,
  onFlushPool,
  onCreated,
  onDuplicate,
  onRemove,
  onChooseDirectory,
  onClose,
}: {
  c: Colors;
  catalog: HostCatalog | undefined;
  catalogs: CatalogRead[];
  directory: string | null;
  projects: readonly Project[];
  repositories: readonly RepositorySettings[];
  initial: (NucleusProfile | Profile) | null;
  entry: PoolEntry | null;
  state: UiQueueState | null;
  busy: boolean;
  poolSaveStatus: string;
  actionStatus?: string;
  onChangePool?: (patch: Partial<PoolEntry>, delay?: number) => void;
  onFlushPool?: () => void;
  onCreated?: (profile: NucleusProfile) => void;
  onDuplicate?: () => void;
  onRemove?: () => Promise<void>;
  onChooseDirectory: (cwd: string) => void;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const createProfile = useRpc(api.createNucleusProfile),
    updateProfile = useRpc(api.updateNucleusProfile);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    initial ? profileDraft(initial) : emptyProfileDraft(),
  );
  const [identityStatus, setIdentityStatus] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [projectChoice, setProjectChoice] = useState(false);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  const idRef = useRef(initial && "id" in initial ? initial.id : null);
  const createRef = useRef(createProfile);
  createRef.current = createProfile;
  const updateRef = useRef(updateProfile);
  updateRef.current = updateProfile;
  const createdRef = useRef(onCreated);
  createdRef.current = onCreated;
  const identitySaver = useRef<AutoSave<ProfileDraft> | null>(null);
  if (!identitySaver.current)
    identitySaver.current = createAutoSave(
      async (value) => {
        if (idRef.current) {
          await updateRef.current({
            id: idRef.current,
            name: value.name.trim(),
            provider: value.provider,
            model: value.model,
            modeId: value.modeId,
            thinkingOptionId: value.thinkingOptionId,
            featureValues: value.featureValues,
          });
        } else {
          const result = await createRef.current(identityCreateInput(value));
          idRef.current = result.profile.id;
          createdRef.current?.(result.profile);
        }
        await queryClient.invalidateQueries({
          queryKey: ["nucleus", "profiles"],
        });
        await queryClient.invalidateQueries({ queryKey: ["nucleus", "state"] });
      },
      (status) => {
        if (mounted.current) setIdentityStatus(status);
      },
    );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void identitySaver.current!.flush();
    };
  }, []);
  function applyIdentity(patch: Partial<ProfileDraft>, delay = 0) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (!identityValid(next)) {
      identitySaver.current!.cancelPending();
      setIdentityStatus(
        next.name.trim() || next.provider || next.model
          ? "A name, a provider and a model are needed."
          : "",
      );
      return;
    }
    identitySaver.current!.enqueue(next, delay);
  }
  const providers = catalog?.providers ?? [];
  const provider = namedProvider(draft.provider, catalog);
  const model =
    provider && draft.model ? hostModelFor(draft.model, provider) : null;
  const availability =
    catalog && draft.provider && draft.model
      ? profileAvailability(
          {
            provider: draft.provider,
            model: draft.model,
            ...(draft.thinkingOptionId
              ? { thinkingOptionId: draft.thinkingOptionId }
              : {}),
            ...(draft.modeId ? { modeId: draft.modeId } : {}),
          },
          catalog,
        )
      : null;
  const providerOptions = [
    ...providers.map((candidate) => ({
      value: candidate.key,
      label: providerOptionLabel(candidate),
    })),
    ...(draft.provider &&
    !providers.some((candidate) => candidate.key === draft.provider)
      ? [{ value: draft.provider, label: `${draft.provider} · unavailable` }]
      : []),
  ];
  const modelOptions = [
    // The model ID tells apart providers routed through one harness (pi, OpenCode); the option drops it when it equals the name.
    ...(provider?.models ?? []).map((candidate) => ({
      value: candidate.id,
      label: candidate.label || candidate.id,
      detail: candidate.id,
    })),
    ...(draft.model &&
    !(provider?.models ?? []).some(
      (candidate) =>
        candidate.id === draft.model || candidate.aliases.includes(draft.model),
    )
      ? [{ value: draft.model, label: draft.model }]
      : []),
  ];
  const chooseProvider = (key: string) =>
    applyIdentity({
      provider: key,
      model: "",
      modeId: null,
      thinkingOptionId: null,
      featureValues: {},
    });
  const chooseModel = (id: string) => {
    const next = provider?.models.find((candidate) => candidate.id === id);
    applyIdentity({
      model: id,
      modeId: null,
      thinkingOptionId: next?.defaultThinkingOptionId ?? null,
      featureValues: Object.fromEntries(
        (next?.features ?? []).map((feature) => [feature.id, feature.value]),
      ),
    });
  };
  // A thinking carrier the migration kept (no canonical match, or a clash) is not
  // a feature the catalog shows; it is shown under Thinking, and choosing any
  // Thinking option replaces it, keeping every other feature value (nucleus#1365).
  // A saved model no host reports now (retired, or its provider unavailable) keeps
  // its one Mode and one Thinking control in canonical values and no features, so a
  // retained value stays shown and repairable without resetting the other feature
  // values a model change would (nucleus#1365).
  const optionModel: Pick<
    HostModel,
    "modes" | "thinkingOptions" | "features"
  > | null =
    model ??
    (draft.provider && draft.model
      ? {
          modes: RUNTIME_MODES.map((mode) => ({
            id: mode,
            ...RUNTIME_MODE_LABELS[mode],
          })),
          thinkingOptions: THINKING_LEVELS.map((level) => ({
            id: level,
            label: THINKING_LABELS[level],
          })),
          features: [],
        }
      : null);
  const hiddenThinking = optionModel
    ? hiddenThinkingValues(
        draft.provider,
        draft.featureValues,
        optionModel.features,
      )
    : [];
  const unlistedThinking = Boolean(
    optionModel &&
      draft.thinkingOptionId &&
      !optionModel.thinkingOptions.some(
        (option) => option.id === draft.thinkingOptionId,
      ),
  );
  const chooseThinking = (value: string) =>
    applyIdentity({
      thinkingOptionId: value || null,
      ...(hiddenThinking.length
        ? {
            featureValues: Object.fromEntries(
              Object.entries(draft.featureValues).filter(
                ([option]) =>
                  !hiddenThinking.some(([hidden]) => hidden === option),
              ),
            ),
          }
        : {}),
    });
  const featureValue = (feature: HostFeature) =>
    Object.prototype.hasOwnProperty.call(draft.featureValues, feature.id)
      ? draft.featureValues[feature.id]
      : feature.value;
  const setFeature = (feature: HostFeature, value: unknown) =>
    applyIdentity({
      featureValues: withCanonicalOption(
        draft.provider,
        draft.featureValues,
        feature.id,
        value,
      ),
    });
  const differing =
    catalogs.length > 1
      ? [
          ...new Set(
            catalogs.map((read) => {
              const host = namedProvider(draft.provider, read.catalog);
              return featureFingerprint(
                host && draft.model ? hostModelFor(draft.model, host) : null,
              );
            }),
          ),
        ].length > 1
        ? [
            ...new Set(
              catalogs.map((read) =>
                projectNameForPath(read.cwd, projects, repositories),
              ),
            ),
          ]
        : []
      : [];
  const identityQuiet = quietSaveStatus(identityStatus);
  const poolQuiet = quietSaveStatus(poolSaveStatus);
  const actionQuiet = quietSaveStatus(actionStatus ?? "");
  const saveStatus = actionQuiet.startsWith("Not saved")
    ? actionQuiet
    : identityQuiet.startsWith("Not saved") ||
        identityQuiet === "A name, a provider and a model are needed." ||
        !poolQuiet
      ? identityQuiet
      : poolQuiet;
  const failed =
    saveStatus.startsWith("Not saved") ||
    saveStatus === "A name, a provider and a model are needed." ||
    saveStatus === "Subscription is required";
  const [editorWidth, setEditorWidth] = useState(0);
  // Paired rows follow the editor's own measured width, not the screen's compact flag:
  // Paseo's settings column (about 640 points) is compact for the screen but fits two columns.
  const narrow = editorWidth > 0 && editorWidth < PAIRED_MIN_WIDTH;
  const half = { flex: 1, minWidth: narrow ? ("100%" as const) : 0 };
  const pair = { ...row, columnGap: 16, rowGap: 12 };
  const name = initial?.name ?? "profile";
  // Every model option the host offers, in a stable order: Mode, Thinking, then features.
  // They flow two to a row; an odd last one spans the row (Tom, 2026-11-08).
  // Mode and Thinking are one control each, in canonical values (nucleus#1365): the
  // catalog already leaves out every option a host uses to carry either, so neither
  // shows again as a feature. A list with nothing but Host default is plain text.
  const hostDefault = (label: string) => (
    <View style={{ gap: space.xxs }}>
      <FieldCaption c={c} text={label} />
      <View style={{ minHeight: control.height, justifyContent: "center" }}>
        <Text
          accessibilityLabel={`${label}, Host default`}
          style={controlText(c)}
        >
          Host default
        </Text>
      </View>
    </View>
  );
  const options: { key: string; node: React.ReactNode }[] = optionModel
    ? [
        {
          key: "mode",
          node: optionModel.modes.length ? (
            <DropdownSelect
              label="Mode"
              value={draft.modeId ?? ""}
              options={[
                HOST_DEFAULT,
                ...optionModel.modes.map((mode) => ({
                  value: mode.id,
                  label: plainWords(mode.label, mode.id),
                })),
              ]}
              onChange={(value) => applyIdentity({ modeId: value || null })}
              c={c}
              disabled={busy}
            />
          ) : (
            hostDefault("Mode")
          ),
        },
        {
          key: "thinking",
          node:
            optionModel.thinkingOptions.length ||
            hiddenThinking.length ||
            unlistedThinking ? (
              <View style={{ gap: space.xxs }}>
                <DropdownSelect
                  label="Thinking"
                  value={draft.thinkingOptionId ?? ""}
                  options={[
                    HOST_DEFAULT,
                    ...optionModel.thinkingOptions.map((option) => ({
                      value: option.id,
                      label: plainWords(option.label, option.id),
                    })),
                    ...(unlistedThinking
                      ? [
                          {
                            value: draft.thinkingOptionId!,
                            label: `${draft.thinkingOptionId} · unavailable`,
                          },
                        ]
                      : []),
                  ]}
                  onChange={chooseThinking}
                  c={c}
                  disabled={busy}
                />
                {hiddenThinking.length > 0 && (
                  <Text
                    accessibilityLabel="Stored thinking option"
                    style={{
                      color: c.statusWarning,
                      fontSize: typeScale.metadata.fontSize,
                      flexShrink: 1,
                    }}
                  >
                    Also stored:{" "}
                    {hiddenThinking
                      .map(
                        ([option, value]) =>
                          `${option} ${typeof value === "string" ? value : JSON.stringify(value)}`,
                      )
                      .join(", ")}
                    . Choose a level to replace it.
                  </Text>
                )}
              </View>
            ) : (
              hostDefault("Thinking")
            ),
        },
        ...optionModel.features.map((feature) => ({
          key: `feature:${feature.id}`,
          node:
            feature.type === "toggle" ? (
              <View style={{ gap: space.xxs }}>
                <FieldCaption c={c} text={feature.label} />
                <View style={row}>
                  <Button
                    matchField
                    c={c}
                    text="On"
                    label={`Feature ${feature.label} on`}
                    selected={featureValue(feature) === true}
                    disabled={busy}
                    onPress={() => setFeature(feature, true)}
                  />
                  <Button
                    matchField
                    c={c}
                    text="Off"
                    label={`Feature ${feature.label} off`}
                    selected={featureValue(feature) === false}
                    disabled={busy}
                    onPress={() => setFeature(feature, false)}
                  />
                </View>
              </View>
            ) : (
              <DropdownSelect
                label={feature.label}
                value={
                  featureValue(feature) == null
                    ? ""
                    : String(featureValue(feature))
                }
                options={[
                  HOST_DEFAULT,
                  ...feature.options.map((option) => ({
                    value: option.id,
                    label: plainWords(option.label, option.id),
                  })),
                ]}
                onChange={(value) => setFeature(feature, value || null)}
                c={c}
                disabled={busy}
              />
            ),
        })),
      ]
    : [];
  const optionRows = Array.from(
    { length: Math.ceil(options.length / 2) },
    (_, i) => options.slice(i * 2, i * 2 + 2),
  );
  /** A slider field's label row: the name and its (?), then the chosen value at the right. */
  const sliderLabel = (
    label: string,
    help: string,
    value: string | null | undefined,
    labels?: Record<string, string>,
  ) => (
    <View style={{ ...row, flexWrap: "nowrap" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <FieldCaption c={c} text={label} help={help} />
      </View>
      <Text
        accessibilityLabel={`${label} value`}
        style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
      >
        {value ? (labels?.[value] ?? levelLabel(value)) : "Unset"}
      </Text>
    </View>
  );
  return (
    <View
      accessibilityLabel={`${initial?.name ?? "New profile"} editor`}
      onLayout={(event) => setEditorWidth(event.nativeEvent.layout.width)}
      style={{
        gap: space.sm,
        padding: space.sm,
        borderRadius: radius.card,
        backgroundColor: c.surface1,
      }}
    >
      {/* Name shares its row with the card actions (Tom, 2026-11-08); the placeholder and accessible label carry "Name". */}
      <View
        accessibilityLabel="Profile name row"
        style={{ ...row, flexWrap: "nowrap" }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field
            hideLabel
            c={c}
            label="Name"
            value={draft.name}
            onChange={(next) => applyIdentity({ name: next }, 600)}
            onBlur={() => void identitySaver.current!.flush()}
            placeholder="Name"
          />
        </View>
        {saveStatus && !failed ? (
          <Text
            accessibilityLiveRegion="polite"
            accessibilityLabel="Profile save status"
            style={muted(c)}
          >
            {saveStatus}
          </Text>
        ) : null}
        {onClose && (
          <ActionButton
            c={c}
            action="close"
            label="Close new profile"
            onPress={onClose}
          />
        )}
        {initial && onDuplicate && (
          <ActionButton
            c={c}
            action="duplicate"
            label={`Duplicate ${initial.name}`}
            onPress={onDuplicate}
            disabled={busy}
          />
        )}
        {initial && onRemove && !confirmingRemove && (
          <ActionButton
            c={c}
            action="remove"
            label={`Remove ${initial.name}`}
            onPress={() => setConfirmingRemove(true)}
            disabled={busy}
          />
        )}
      </View>
      {/* A failure needs room to read, so it takes its own line under the Name row. */}
      {saveStatus && failed ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel="Profile save status"
          style={{ ...muted(c), color: c.statusWarning, flexShrink: 1 }}
        >
          {saveStatus}
        </Text>
      ) : null}
      {/* Subscription takes the row; Weight now sits beside Capability. */}
      {entry && onChangePool && state && (
        <View accessibilityLabel="Profile dispatch row">
          <Field
            c={c}
            label="Subscription"
            invalid={saveStatus === "Subscription is required"}
            value={entry.group}
            onChange={(group) => onChangePool({ group }, 600)}
            onBlur={onFlushPool}
          />
        </View>
      )}
      <View style={{ ...pair, alignItems: "stretch" }}>
        <View style={half}>
          <DropdownSelect
            label="Provider"
            value={draft.provider}
            options={providerOptions}
            onChange={chooseProvider}
            c={c}
            disabled={busy}
            placeholder="Choose a provider"
            emptyText={
              catalog
                ? "No host reports a provider."
                : "Reading providers and models…"
            }
          />
        </View>
        <View style={half}>
          <DropdownSelect
            label="Model"
            value={draft.model}
            options={modelOptions}
            onChange={chooseModel}
            c={c}
            disabled={busy || !draft.provider}
            placeholder="Choose a model"
            emptyText={
              provider
                ? "No host reports a model for this provider."
                : "Choose a provider first."
            }
          />
        </View>
      </View>
      {optionRows.map((cells) => (
        <View
          key={cells.map((cell) => cell.key).join("|")}
          accessibilityLabel="Model options row"
          style={{ ...pair, alignItems: "flex-end" }}
        >
          {cells.map((cell) => (
            <View key={cell.key} style={half}>
              {cell.node}
            </View>
          ))}
        </View>
      ))}
      {differing.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text
            accessibilityRole="alert"
            style={{
              color: c.statusWarning,
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            Feature values differ for{" "}
            {differing.length === 2
              ? differing.join(" and ")
              : differing.join(", ")}
            .
          </Text>
          <Disclosure
            c={c}
            label="Choose which project to use"
            expanded={projectChoice}
            onToggle={() => setProjectChoice((open) => !open)}
          />
          {projectChoice && (
            <DropdownSelect
              label="Project"
              value={directory ?? ""}
              options={catalogs.map((read) => ({
                value: read.cwd,
                label: projectNameForPath(read.cwd, projects, repositories),
              }))}
              onChange={onChooseDirectory}
              c={c}
            />
          )}
        </View>
      )}
      {availability && !availability.available && (
        <Text
          accessibilityLabel="Profile availability preview"
          style={{
            color: c.statusWarning,
            fontSize: typeScale.metadata.fontSize,
          }}
        >
          {availability.problem}
        </Text>
      )}
      {entry && onChangePool && state && (
        <View style={{ ...pair, alignItems: "flex-start" }}>
          <View style={{ ...half, gap: space.xs }}>
            {sliderLabel(
              "Weight",
              `Moves this profile's turn in rotation among profiles already eligible for the work: fewer or more assignments than Default, one step at a time. It never makes a profile eligible or ineligible.${initial ? ` Recent assignments: ${state.recentAssignments[`profile:${initial.id}`] ?? 0}; total assignments: ${state.assignments[`profile:${initial.id}`] ?? 0}.` : ""}`,
              entry.weight,
              WEIGHT_STOP_LABELS,
            )}
            <StopSlider
              captions={false}
              markStop="default"
              c={c}
              a11yLabel="Weight"
              stops={api.profileWeightLevels}
              unsetStop="default"
              disabled={busy}
              value={entry.weight}
              labelFor={(stop) => WEIGHT_STOP_LABELS[stop]}
              stopLabel={(stop) => WEIGHT_STOP_SPEECH[stop]}
              onChange={(weight) => onChangePool({ weight })}
            />
          </View>
          <View style={{ ...half, gap: space.xs }}>
            {sliderLabel(
              "Capability",
              "Low complexity runs on Mechanical, medium and high on Worker, very high on Heavyweight; a high task may step up to Heavyweight after review changes. Frontier requires a request at Low, Normal and High. Heavyweight does too at Low and Normal unless the task starts or climbs there. Unset counts as Worker.",
              entry.capability,
            )}
            <StopSlider
              captions={false}
              c={c}
              a11yLabel="Capability"
              stops={PROFILE_CAPABILITY_LEVELS}
              unsetStop="worker"
              value={entry.capability ?? null}
              labelFor={(level) => BRACKET_LABELS[level]}
              stopLabel={(level) => `Capability ${BRACKET_LABELS[level]}`}
              onChange={(level) =>
                onChangePool({
                  capability: entry.capability === level ? null : level,
                })
              }
            />
          </View>
        </View>
      )}
      {initial && confirmingRemove && onRemove && (
        <View
          style={{
            ...row,
            gap: space.sm,
            paddingTop: space.xs,
          }}
        >
          <Text
            style={{
              color: c.statusWarning,
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            Remove {initial.name}?
          </Text>
          <Button
            small
            danger
            c={c}
            text="Remove profile"
            label={`Confirm removing ${initial.name}`}
            disabled={busy}
            onPress={() => void onRemove()}
          />
          <Button
            small
            c={c}
            text="Keep"
            label={`Keep ${initial.name}`}
            onPress={() => setConfirmingRemove(false)}
          />
        </View>
      )}
    </View>
  );
}

/**
 * One Profiles page: stored records and their dispatch settings. Add, duplicate
 * and remove live here. Feature values come from one automatically chosen
 * directory. Nothing is stored differently; only how it is shown changes.
 */
