/** Small pieces of the Rust task detail view (Spec 071): tooltips, quiet buttons, pills and the meter. */
import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { FocusRing, noOutline, popover, row, type Colors } from "../controls";
import { useFocusVisible } from "../focus-modality";
import { Popover } from "../popover";
import { radius, roles, space, taskDetail, toneSurface, type as typeScale } from "../design";
import type { TimelineTone } from "./rust-timeline";

export function toneColor(tone: TimelineTone, c: Colors): string {
  const r = roles(c);
  return { accent: r.accent, danger: r.danger, warning: r.warning, success: r.success, muted: r.muted }[tone];
}

export const metaText = (c: Colors) => ({
  ...typeScale.metadata,
  color: c.foregroundLabel ?? c.foregroundMuted,
});

/**
 * Hover or keyboard focus shows `text` above the children. The text is also the
 * accessible name, so a screen reader hears what a pointer sees.
 */
export function Hint({
  c,
  text,
  label,
  children,
  style,
  focusable = false,
}: {
  c: Colors;
  text: string;
  label?: string;
  children: ReactNode;
  style?: ViewStyle;
  focusable?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const anchor = useRef<View | null>(null);
  const open = Boolean(text) && (hovered || focus.visible);
  return (
    <Pressable
      ref={anchor}
      accessibilityLabel={label ?? (text.replace(/\n/g, " · ") || undefined)}
      tabIndex={focusable ? 0 : -1}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={{ ...noOutline(), ...style }}
    >
      {children}
      {open && (
        <Popover anchor={anchor} pointerEvents="none" maxWidth={280}>
          <View
            role="tooltip"
            style={{
              ...popover(c),
              paddingHorizontal: space.xs,
              paddingVertical: space.xxs,
              borderRadius: radius.control,
            }}
          >
            <Text style={{ ...typeScale.metadata, color: roles(c).foreground }}>{text}</Text>
          </View>
        </Popover>
      )}
    </Pressable>
  );
}

/** A text-only button: `ghost` for secondary actions, `danger` for the footer's Cancel. */
export function QuietButton({
  c,
  text,
  label,
  danger = false,
  disabled = false,
  onPress,
}: {
  c: Colors;
  text: string;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const r = roles(c);
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const color = danger ? r.danger : hovered ? r.foreground : (c.foregroundLabel ?? r.muted);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? text}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      hitSlop={{ top: 7, bottom: 7 }}
      style={{
        ...noOutline(),
        height: 30,
        paddingHorizontal: space.xs,
        borderRadius: radius.control,
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        backgroundColor: hovered && !disabled
          ? danger
            ? toneSurface(r.danger, "transparent", 0.1)
            : r.hover
          : "transparent",
      }}
    >
      <FocusRing c={c} visible={focus.visible} />
      <Text style={{ ...typeScale.body, color }}>{text}</Text>
    </Pressable>
  );
}

export function Pill({ c, tone, text }: { c: Colors; tone: TimelineTone; text: string }) {
  const color = toneColor(tone, c);
  return (
    <View
      style={{
        height: 20,
        paddingHorizontal: space.xs,
        borderRadius: radius.full,
        justifyContent: "center",
        backgroundColor: toneSurface(color, roles(c).raised, taskDetail.severityAlpha),
      }}
    >
      <Text style={{ ...typeScale.metadata, fontWeight: "600", color }}>{text}</Text>
    </View>
  );
}

export function Dot({ c, tone }: { c: Colors; tone: TimelineTone }) {
  return (
    <View
      style={{
        width: 6,
        height: 6,
        borderRadius: radius.full,
        backgroundColor: toneColor(tone, c),
      }}
    />
  );
}

/** A slim used/limit bar: warning from three quarters, muted once the task finished. */
export function Meter({ c, ratio, finished }: { c: Colors; ratio: number; finished: boolean }) {
  const r = roles(c);
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <View
      style={{
        height: taskDetail.budgetBarHeight,
        borderRadius: radius.full,
        backgroundColor: r.raised,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.round(clamped * 100)}%`,
          height: "100%",
          borderRadius: radius.full,
          backgroundColor: finished ? r.muted : clamped >= 0.75 ? r.warning : r.accent,
        }}
      />
    </View>
  );
}

/** One labelled row in a card: a fixed label column, then the content. */
export function LabelRow({ c, label, children }: { c: Colors; label: string; children: ReactNode }) {
  return (
    <View style={{ ...row, flexWrap: "nowrap", gap: space.sm, minHeight: 28 }}>
      <Text style={{ ...metaText(c), width: 72, flexShrink: 0 }}>{label}</Text>
      {children}
    </View>
  );
}
