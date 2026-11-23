import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { inboxViews, type InboxView } from "../../shared/inbox-board";
import { Icon } from "../shell";
import { useFocusVisible } from "../focus-modality";
import type { Colors } from "../controls";
import {
  hoverSurface,
  radius,
  selectedSurface,
  space,
  toneSurface,
  type as typeScale,
  wash,
} from "../design";

export type InboxMenuCounts = Record<InboxView, number>;

/**
 * One menu entry (nucleus#1528): the same sidebar hover as a list row — a dimmed
 * background on hover and keyboard focus, the selected surface when selected.
 * Hover over the selected entry keeps it; a dimmed zero-count entry still hovers.
 */
function MenuEntry({
  c,
  label,
  on,
  value,
  loaded,
  onPress,
  options,
}: {
  c: Colors;
  label: string;
  on: boolean;
  value: number | null;
  loaded: boolean;
  onPress: () => void;
  options: {
    icon?: string;
    hot?: boolean;
    dimmed?: boolean;
    countNoun?: string;
  };
}) {
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const themedNavigation = Boolean(c.surfaceNavigation);
  const navigationTint = (fallback: string, alpha: number) =>
    themedNavigation ? toneSurface(c.foreground, fallback, alpha) : fallback;
  const backgroundColor = on
    ? navigationTint(selectedSurface(c), wash.selected)
    : hovered || focus.visible
      ? navigationTint(hoverSurface(c), wash.hover)
      : "transparent";
  // Keep zero-count labels quieter without fading the entire interaction fill.
  const labelColor = on
    ? c.foreground
    : navigationTint(c.foregroundMuted, options.dimmed ? 0.72 : 0.85);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={
        value === null || !loaded
          ? label
          : options.countNoun
            ? `${label}, ${value} ${options.countNoun}`
            : `${label}, ${value}`
      }
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 36,
        paddingHorizontal: space.sm,
        borderRadius: radius.control,
        backgroundColor,
        opacity: options.dimmed && !on && !themedNavigation ? 0.55 : 1,
      }}
    >
      {options.icon && (
        <Icon
          name={options.icon}
          size={16}
          color={labelColor}
        />
      )}
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          color: labelColor,
          fontSize: typeScale.body.fontSize,
        }}
      >
        {label}
      </Text>
      {value !== null &&
        loaded &&
        (options.hot && value > 0 ? (
          <View
            style={{
              minWidth: 20,
              paddingHorizontal: space.xs,
              borderRadius: radius.panel,
              backgroundColor: c.accent,
              alignItems: "center",
            }}
          >
            <Text
              style={{
                color: c.accentForeground,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: 18,
                fontWeight: "600",
              }}
            >
              {value}
            </Text>
          </View>
        ) : (
          <Text
            style={{
              color: themedNavigation ? labelColor : c.foregroundMuted,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            {value}
          </Text>
        ))}
    </Pressable>
  );
}

/**
 * The board menu (Tom, 2026-11-21): Needs you, a divider, Planning, Leads,
 * Papercuts, Queue, a divider, then Working, In review and Closing. Counts are
 * real totals — Planning shows the number of open lanes in scope (nucleus#1546);
 * only Needs you is highlighted, because only it asks the operator to act. A count is hidden until the board loads. An entry whose count is 0
 * renders dimmed but stays selectable; the selected entry keeps its styling.
 * Hover and keyboard focus dim an entry like a list row; hovering the selected
 * entry keeps it.
 */
export function InboxMenu({
  c,
  view,
  counts,
  loaded,
  onSelect,
}: {
  c: Colors;
  view: InboxView;
  counts: InboxMenuCounts;
  loaded: boolean;
  onSelect: (view: InboxView) => void;
}) {
  const count = (id: InboxView) => counts[id];
  const item = (
    key: string,
    label: string,
    on: boolean,
    value: number | null,
    onPress: () => void,
    options: {
      icon?: string;
      hot?: boolean;
      dimmed?: boolean;
      countNoun?: string;
    } = {},
  ) => (
    <MenuEntry
      key={key}
      c={c}
      label={label}
      on={on}
      value={value}
      loaded={loaded}
      onPress={onPress}
      options={options}
    />
  );
  // Groups part with spacing, not a drawn line (nucleus#1540).
  const divider = (key: string) => (
    <View key={key} style={{ height: space.md }} />
  );
  return (
    <ScrollView
      accessibilityRole="tablist"
      accessibilityLabel="Nucleus navigation"
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ padding: space.xs, gap: 2 }}
    >
      {inboxViews.map((entry) => (
        <React.Fragment key={entry.id}>
          {(entry.id === "planning" || entry.id === "working") &&
            divider(`${entry.id}-divider`)}
          {item(
            entry.id,
            entry.label,
            view === entry.id,
            count(entry.id),
            () => onSelect(entry.id),
            {
              icon: entry.icon,
              hot: entry.id === "needs",
              // Planning names its unit, so the count reads as open lanes.
              countNoun: entry.id === "planning" ? "open lanes" : undefined,
              // An unloaded entry's hidden count never dims; a loaded zero does.
              dimmed: loaded && count(entry.id) === 0,
            },
          )}
        </React.Fragment>
      ))}
    </ScrollView>
  );
}
