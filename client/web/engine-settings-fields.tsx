import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import {
  Disclosure,
  DropdownSelect,
  Field,
  FieldCaption,
  NumberStepper,
  muted,
  row,
  useSectionAutoSave,
  type Colors,
} from "../controls";
import { space } from "../design";

export function SettingsDisclosure({
  c,
  label,
  children,
}: {
  c: Colors;
  label: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      <Disclosure
        c={c}
        label={label}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded && <View style={{ paddingLeft: space.sm }}>{children}</View>}
    </View>
  );
}

export function EditText({
  c,
  label,
  value,
  disabled,
  onSave,
  multiline,
}: {
  c: Colors;
  label: string;
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Field
      c={c}
      label={label}
      value={draft}
      onChange={setDraft}
      disabled={disabled}
      multiline={multiline}
      onBlur={() => {
        const next = multiline ? draft : draft.trim();
        if (next !== value) onSave(next);
      }}
    />
  );
}

export function EditNumber({
  c,
  label,
  value,
  disabled,
  onSave,
  unit,
  onClear,
}: {
  c: Colors;
  label: string;
  value: number | null;
  disabled: boolean;
  onSave: (value: number) => Promise<boolean>;
  unit?: string;
  onClear?: () => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ value: number | null }>();
  const autosave = useSectionAutoSave(
    async (edit: { value: number | null }) => {
      if (edit.value === null) await onClear?.();
      else await onSave(edit.value);
      setDraft((current) => (current === edit ? undefined : current));
    },
  );
  const change = (next: number | null) => {
    const edit = { value: next };
    setDraft(edit);
    autosave.enqueue(edit, 300);
  };
  return (
    <NumberStepper
      c={c}
      a11yLabel={label}
      label={label}
      value={draft ? draft.value : value}
      min={1}
      max={4_294_967_295}
      onChange={change}
      onClear={onClear && (() => change(null))}
      onCommit={() => void autosave.saver.flush()}
      unit={unit}
      disabled={disabled}
    />
  );
}

export function EditToggle({
  c,
  label,
  checked,
  disabled,
  onSave,
}: {
  c: Colors;
  label: string;
  checked: boolean;
  disabled: boolean;
  onSave: (checked: boolean) => void;
}) {
  return (
    <View style={{ ...row, justifyContent: "space-between", gap: space.md }}>
      <FieldCaption c={c} text={label} />
      <Switch
        accessibilityLabel={label}
        value={checked}
        onValueChange={onSave}
        disabled={disabled}
        trackColor={{ false: c.border, true: c.accent }}
      />
    </View>
  );
}

export function EditChoice<T extends string>({
  c,
  label,
  value,
  choices,
  disabled,
  onSave,
  labelFor = humanLabel,
}: {
  c: Colors;
  label: string;
  value: T;
  choices: readonly T[];
  disabled: boolean;
  onSave: (value: T) => void;
  labelFor?: (choice: T) => string;
}) {
  return (
    <DropdownSelect
      c={c}
      label={label}
      value={value}
      options={choices.map((choice) => ({
        value: choice,
        label: labelFor(choice),
      }))}
      disabled={disabled}
      onChange={(next) => {
        const choice = choices.find((item) => item === next);
        if (choice !== undefined) onSave(choice);
      }}
    />
  );
}

export function SettingValue({
  c,
  label,
  value,
}: {
  c: Colors;
  label: string;
  value: string;
}) {
  return (
    <View style={{ gap: space.xxs }}>
      <FieldCaption c={c} text={label} />
      <Text selectable style={muted(c)}>
        {value}
      </Text>
    </View>
  );
}

export function humanLabel(value: string) {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
