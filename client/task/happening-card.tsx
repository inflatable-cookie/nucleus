import { useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "../shell";
import {
  Button,
  Field,
  muted,
  row,
  useCardFill,
  type Colors,
} from "../controls";
import { errorText } from "../error-text";
import * as api from "../../shared/contracts";
import type {
  ExplicitResolution,
  ResolutionWarningId,
  TaskControlInput,
  TaskNext,
  TaskNextExplicitCommand,
  TaskNextVerb,
  UiQueueState,
} from "../../shared/contracts";
import { taskActionPlan } from "../../shared/task-detail-summary";
import {
  explicitCommandLabel,
  type TaskHappening,
} from "../../shared/task-detail-view";
import {
  NORMAL_USAGE,
  VerbField,
  verbKey,
  verbLabel,
  verbText,
} from "./next-section";
import { RecordNotice } from "./parts";
import { isEditingVerb } from "./task-menu";
import { VerbForm } from "./verb-form";
import {
  radius,
  roles,
  space,
  taskDetail,
  toneSurface,
  type as typeScale,
} from "../design";

type ExplicitWarning = { id: ResolutionWarningId; text: string };

type PendingWarningState = {
  command: TaskNextExplicitCommand;
  values: Record<string, string>;
  warnings: ExplicitWarning[];
};

const EXPLICIT_FIELD_LABELS: Record<string, string> = {
  reason: "Reason",
  text: "Message",
  instruction: "Instruction",
  head: "Commit SHA",
};

const EXPLICIT_FIELD_PLACEHOLDERS: Record<string, string> = {
  reason: "Why you are running this command",
  text: "Message to send to the thread",
  instruction: "Bounded instruction for the next turn",
  head: "Full 40-character commit SHA",
};

function commandKey(cmd: TaskNextExplicitCommand, index: number): string {
  return `${cmd.action}:${JSON.stringify(cmd.args)}:${index}`;
}

/**
 * The Overview's "What's happening" card (nucleus#1537):
 * - Plain eyebrow label, headline, explanation and "Next:" line
 * - Danger tint when the task needs the operator
 * - Buttons for `next.explicitCommands` with human labels (primary filled)
 * - Inline warning responses with Accept-and-retry for the named warning ids
 * - "More ▾" button holding the rest of `next`'s available owner verbs.
 */
export function HappeningCard({
  taskId,
  happening,
  next,
  nextLoading,
  nextError,
  onRetryNext,
  state,
  busy,
  c,
}: {
  taskId: string;
  happening: TaskHappening;
  next: TaskNext | null;
  nextLoading: boolean;
  nextError: string | null;
  onRetryNext: () => void;
  state: UiQueueState | undefined;
  busy: boolean;
  c: Colors;
}) {
  const r = roles(c);
  const fill = useCardFill(c);
  const queryClient = useQueryClient();
  const setTask = useRpc(api.taskControl);

  const [selectedCmdKey, setSelectedCmdKey] = useState<string | null>(null);
  const [cmdValues, setCmdValues] = useState<Record<string, string>>({});
  const [pendingWarnings, setPendingWarnings] =
    useState<PendingWarningState | null>(null);

  const [moreOpen, setMoreOpen] = useState(false);
  const [activeVerbKey, setActiveVerbKey] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const refreshTask = async () => {
    await queryClient.refetchQueries({
      queryKey: ["nucleus", "state"],
      exact: true,
    });
    await queryClient.invalidateQueries({
      queryKey: ["nucleus", "detail", taskId],
      exact: true,
    });
    await queryClient.invalidateQueries({
      queryKey: ["nucleus", "next", taskId],
      exact: true,
    });
  };

  const explicitCommands = next?.explicitCommands ?? [];
  const forceVerbs: TaskNextVerb[] = (next?.verbs ?? []).flatMap((verb) =>
    verb.forceArgs
      ? [
          {
            ...verb,
            available: true,
            args: verb.forceArgs,
            fill: verb.forceFill,
            refusal: undefined,
            forceArgs: undefined,
            forceFill: undefined,
            note: "Force records your reason and settles the named blockers.",
          },
        ]
      : [],
  );
  // Editing verbs (routing, holds, dependencies, budget) live in the ⋯ menu.
  const plan = taskActionPlan(
    (next?.verbs ?? []).filter((verb) => !isEditingVerb(verb.verb)),
  );
  const availableVerbs = [...plan.primary, ...plan.more, ...forceVerbs];

  // When there are no explicit commands, lead with the primary available owner verbs,
  // and put the remaining verbs under More ▾.
  const leadVerbs = explicitCommands.length === 0 ? plan.primary : [];
  const moreVerbs =
    explicitCommands.length === 0
      ? [...plan.more, ...forceVerbs]
      : availableVerbs;

  const selectedCommand =
    explicitCommands.find(
      (cmd, idx) => commandKey(cmd, idx) === selectedCmdKey,
    ) ?? null;
  const activeVerb =
    availableVerbs.find((verb) => verbKey(verb) === activeVerbKey) ?? null;

  const submitExplicitCommand = async (
    cmd: TaskNextExplicitCommand,
    values: Record<string, string>,
    accept: ResolutionWarningId[] = [],
  ) => {
    setApplying(true);
    setNotice(null);
    try {
      const filled = Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => Boolean(v)),
      );
      const payload = {
        ...cmd.args,
        ...filled,
        action: cmd.action,
        accept,
        caller: "operator (board)",
      } as unknown as ExplicitResolution;
      const result = await setTask(payload);
      await refreshTask();

      if (
        result &&
        typeof result === "object" &&
        "explicitResolution" in result
      ) {
        const res = result.explicitResolution;
        if (res?.status === "warnings") {
          setPendingWarnings({
            command: cmd,
            values,
            warnings: res.warnings,
          });
          setNotice(null);
          return;
        }
        if (res?.status === "stale" || res?.status === "retry") {
          setPendingWarnings(null);
          setNotice({
            kind: "error",
            text:
              res.next ||
              "Task state changed; review the updated state and try again.",
          });
          return;
        }
        setPendingWarnings(null);
        setSelectedCmdKey(null);
        setCmdValues({});
        setNotice({
          kind: "ok",
          text: res?.next || `Applied ${explicitCommandLabel(cmd)}.`,
        });
        return;
      }

      setPendingWarnings(null);
      setSelectedCmdKey(null);
      setCmdValues({});
      setNotice({
        kind: "ok",
        text: `Applied ${explicitCommandLabel(cmd)}.`,
      });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    } finally {
      setApplying(false);
    }
  };

  const onPressExplicitCommand = (
    cmd: TaskNextExplicitCommand,
    index: number,
  ) => {
    const key = commandKey(cmd, index);
    setActiveVerbKey(null);
    setPendingWarnings(null);
    setNotice(null);
    if (cmd.fill.length === 0) {
      void submitExplicitCommand(cmd, {}, []);
      return;
    }
    if (selectedCmdKey === key) {
      setSelectedCmdKey(null);
      setCmdValues({});
    } else {
      setSelectedCmdKey(key);
      setCmdValues({});
    }
  };

  const onSelectVerb = (key: string) => {
    setSelectedCmdKey(null);
    setPendingWarnings(null);
    setNotice(null);
    setActiveVerbKey(activeVerbKey === key ? null : key);
  };

  const isDanger = happening.tone === "danger";
  // A danger card reads by its tint alone, with no border (nucleus#1540).
  const cardBg = isDanger
    ? toneSurface(r.danger, fill, taskDetail.attnAlpha)
    : fill;
  const eyebrowColor = isDanger ? r.danger : r.muted;

  const cmdMissing = Boolean(
    selectedCommand?.fill.some((field) => !cmdValues[field]?.trim()),
  );

  return (
    <View
      accessibilityLabel={`What is happening: ${happening.label}. ${happening.headline}`}
      style={{
        borderRadius: radius.panel,
        padding: space.md,
        backgroundColor: cardBg,
        gap: space.xs,
      }}
    >
      <Text
        style={{
          color: eyebrowColor,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          letterSpacing: taskDetail.eyebrowTracking,
          textTransform: "uppercase",
          fontWeight: "600",
        }}
      >
        {happening.label}
      </Text>
      <Text
        style={{
          color: r.foreground,
          fontSize: typeScale.section.fontSize,
          lineHeight: typeScale.section.lineHeight,
          fontWeight: "600",
        }}
      >
        {happening.headline}
      </Text>
      <Text
        style={{
          color: r.muted,
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
        }}
      >
        {happening.explanation}
      </Text>
      <Text
        style={{
          color: r.muted,
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
          marginTop: space.xxs / 2,
        }}
      >
        <Text style={{ color: r.foreground, fontWeight: "600" }}>Next: </Text>
        {happening.nextLine}
      </Text>

      {!next && nextLoading && !nextError && (
        <Text
          accessibilityLabel="Reading owner verbs"
          style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
        >
          Reading owner verbs…
        </Text>
      )}

      {/* Refresh / load errors */}
      {nextError && (
        <View style={{ ...row, gap: space.xs }}>
          <Text
            accessibilityLabel={`Owner verbs could not be read: ${nextError}`}
            style={{
              color: r.warning,
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {next
              ? `Refresh failed: ${nextError}. Showing the last reading.`
              : `Could not load actions: ${nextError}`}
          </Text>
          <Button
            small
            c={c}
            text="Retry"
            label="Retry reading owner verbs"
            disabled={nextLoading}
            onPress={onRetryNext}
          />
        </View>
      )}

      {/* Action buttons: explicit commands first (primary filled), else primary verbs, plus More ▾ */}
      {(explicitCommands.length > 0 ||
        leadVerbs.length > 0 ||
        moreVerbs.length > 0) && (
        <View style={{ ...row, gap: space.xs, marginTop: space.xs }}>
          {explicitCommands.map((cmd, idx) => {
            const label = explicitCommandLabel(cmd);
            const key = commandKey(cmd, idx);
            return (
              <Button
                key={key}
                small
                c={c}
                text={label}
                label={label}
                hint={cmd.note}
                selected={idx === 0 || selectedCmdKey === key}
                disabled={busy || applying}
                onPress={() => onPressExplicitCommand(cmd, idx)}
              />
            );
          })}
          {leadVerbs.map((verb, idx) => (
            <Button
              key={verbKey(verb)}
              small
              c={c}
              text={verbText(verb)}
              label={verbText(verb)}
              hint={verb.note}
              selected={
                idx === 0 && explicitCommands.length === 0 && !activeVerbKey
                  ? true
                  : activeVerbKey === verbKey(verb)
              }
              disabled={busy || applying}
              onPress={() => onSelectVerb(verbKey(verb))}
            />
          ))}
          {moreVerbs.length > 0 && (
            <Button
              small
              c={c}
              text={moreOpen ? "More ▴" : "More ▾"}
              label={
                moreOpen
                  ? "Hide more actions"
                  : `Show ${moreVerbs.length} more actions`
              }
              selected={moreOpen}
              onPress={() => setMoreOpen(!moreOpen)}
            />
          )}
        </View>
      )}

      {/* Expanded More owner verbs */}
      {moreOpen && moreVerbs.length > 0 && (
        <View
          style={{
            ...row,
            gap: space.xs,
            paddingTop: space.xs,
          }}
        >
          {moreVerbs.map((verb) => (
            <Button
              key={verbKey(verb)}
              small
              c={c}
              text={verbText(verb)}
              label={verbText(verb)}
              hint={verb.note}
              selected={activeVerbKey === verbKey(verb)}
              disabled={busy || applying}
              onPress={() => onSelectVerb(verbKey(verb))}
            />
          ))}
        </View>
      )}

      {/* Explicit command inline fill form */}
      {selectedCommand && (
        <View
          style={{
            gap: space.xs,
            paddingTop: space.xs,
          }}
        >
          <Text
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            {selectedCommand.note}
          </Text>
          {selectedCommand.fill.map((field) => (
            <Field
              key={field}
              c={c}
              label={`${EXPLICIT_FIELD_LABELS[field] ?? field} (required)`}
              value={cmdValues[field] ?? ""}
              onChange={(val) =>
                setCmdValues((cur) => ({ ...cur, [field]: val }))
              }
              multiline={field === "text" || field === "instruction"}
              placeholder={EXPLICIT_FIELD_PLACEHOLDERS[field] ?? field}
            />
          ))}
          <View style={row}>
            <Button
              small
              c={c}
              selected
              text="Run"
              label={`Confirm ${explicitCommandLabel(selectedCommand)}`}
              disabled={busy || applying || cmdMissing}
              onPress={() =>
                void submitExplicitCommand(selectedCommand, cmdValues, [])
              }
            />
            <Button
              small
              c={c}
              text="Cancel"
              onPress={() => {
                setSelectedCmdKey(null);
                setCmdValues({});
                setPendingWarnings(null);
              }}
            />
          </View>
        </View>
      )}

      {/* Inline warning response with Accept-and-retry */}
      {pendingWarnings && (
        <View
          accessibilityRole="alert"
          style={{
            gap: space.xs,
            padding: space.sm,
            borderRadius: radius.control,
            backgroundColor: toneSurface(
              r.warning,
              r.section,
              taskDetail.attnAlpha,
            ),
          }}
        >
          <Text
            style={{
              color: r.warning,
              fontSize: typeScale.metadata.fontSize,
              fontWeight: "600",
            }}
          >
            Confirm warnings before applying
          </Text>
          {pendingWarnings.warnings.map((w) => (
            <Text
              key={w.id}
              style={{
                color: r.foreground,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              • {w.text}
            </Text>
          ))}
          <View style={row}>
            <Button
              small
              c={c}
              selected
              text="Accept and retry"
              label="Accept warnings and retry"
              disabled={busy || applying}
              onPress={() =>
                void submitExplicitCommand(
                  pendingWarnings.command,
                  pendingWarnings.values,
                  pendingWarnings.warnings.map((w) => w.id),
                )
              }
            />
            <Button
              small
              c={c}
              text="Dismiss"
              onPress={() => setPendingWarnings(null)}
            />
          </View>
        </View>
      )}

      {/* Active owner verb inline fill form */}
      {activeVerb && next && (
        <VerbForm
          key={verbKey(activeVerb)}
          taskId={taskId}
          verb={activeVerb}
          next={next}
          state={state}
          busy={busy}
          onDone={(done) => {
            setNotice(done);
            setActiveVerbKey(null);
          }}
          onCancel={() => setActiveVerbKey(null)}
          c={c}
        />
      )}

      {notice && <RecordNotice notice={notice} c={c} />}
    </View>
  );
}
