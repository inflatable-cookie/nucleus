import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  Button,
  DetailSection,
  Field,
  TextLink,
  muted,
  row,
  type Colors,
} from "../controls";
import { space, type as typeScale } from "../design";

/** One prerequisite row in task detail. Without `onPress` the row is plain text. */
export type PrerequisiteItem = {
  key: string;
  text: string;
  onPress?: () => void;
};

/**
 * The task-detail prerequisite list, shared by both engines: one row per
 * prerequisite, each opening that task when it can still be read.
 */
export function PrerequisiteList({
  title = "Prerequisites",
  note,
  items,
  c,
}: {
  title?: string;
  note?: string;
  items: readonly PrerequisiteItem[];
  c: Colors;
}) {
  return (
    <DetailSection title={title} c={c}>
      {note && (
        <Text selectable style={{ color: c.foreground }}>
          {note}
        </Text>
      )}
      {items.map((item) =>
        item.onPress ? (
          <TextLink key={item.key} c={c} text={item.text} onPress={item.onPress} />
        ) : (
          <Text
            key={item.key}
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            {item.text}
          </Text>
        ),
      )}
    </DetailSection>
  );
}

/** A dependency list in one comparable form: entries split on commas or spaces. */
export function dependencyEntries(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
const normalized = (text: string) => dependencyEntries(text).join(",");

/**
 * The dependency editor, shared by both engines. Its text starts from the task's
 * stored list and lives only while the editor is open for this task, so another
 * task's draft can never reach it. Save stays disabled until the list differs
 * from the stored one, so an untouched form never submits and an empty list goes
 * out only on purpose. Callers key it by task.
 */
export function DependencyListEditor({
  stored: storedList,
  busy,
  reason: withReason = true,
  onSave,
  onClose,
  c,
}: {
  stored: readonly string[];
  busy: boolean;
  /** Whether the engine records an edit reason. */
  reason?: boolean;
  onSave: (dependsOn: string[], reason: string) => void;
  onClose: () => void;
  c: Colors;
}) {
  const stored = storedList.join(", ");
  // The list the edit started from. An untouched form follows refreshes; an
  // edited one is fenced to its starting list, so a prerequisite added elsewhere
  // while it is open is never cleared by a save the operator did not intend.
  const [base, setBase] = useState(stored);
  const [depsText, setDepsText] = useState(stored);
  const [depsReason, setDepsReason] = useState("");
  const edited = normalized(depsText) !== normalized(base);
  const moved = normalized(stored) !== normalized(base);
  useEffect(() => {
    if (moved && !edited) {
      setBase(stored);
      setDepsText(stored);
    }
  }, [stored, moved, edited]);
  const changed = edited && !moved;
  return (
    <DetailSection title="Set dependencies" c={c}>
      {moved && edited && (
        <View accessibilityRole="alert" style={{ gap: space.xs }}>
          <Text
            style={{
              color: c.statusWarning,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            These prerequisites changed while you were editing: now{" "}
            {stored || "none"}.
          </Text>
          <Button
            small
            c={c}
            text="Start from the current list"
            onPress={() => {
              setBase(stored);
              setDepsText(stored);
            }}
          />
        </View>
      )}
      <Field
        c={c}
        label="Prerequisites (comma-separated task IDs or references; leave empty to clear)"
        value={depsText}
        onChange={setDepsText}
        placeholder="e.g. #1501, #1502"
      />
      {withReason && (
        <Field
          c={c}
          label="Reason (optional)"
          value={depsReason}
          onChange={setDepsReason}
          placeholder="Why the dependency list changed"
        />
      )}
      <View style={row}>
        <Button
          small
          c={c}
          text="Save dependencies"
          label="Save dependencies"
          disabled={busy || !changed}
          onPress={() =>
            onSave(dependencyEntries(depsText), withReason ? depsReason.trim() : "")
          }
        />
        <Button small c={c} text="Close" onPress={onClose} />
      </View>
    </DetailSection>
  );
}
