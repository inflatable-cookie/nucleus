import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { activeSections, inboxViews, type ActiveSection, type InboxView } from "../../shared/inbox-board";
import { Icon } from "../shell";
import { muted, type Colors } from "../controls";
import { radius, space, type as typeScale } from "../design";

export type InboxMenuCounts = {
  needs: number; leads: number; papercuts: number; queue: number; active: number;
  activeBySection: Record<ActiveSection, number>;
};

/**
 * The board menu (Tom, 2026-11-21): Needs you, Planning, Leads, Papercuts, Queue and
 * Active with its three sections. Counts are real totals; only Needs you is highlighted,
 * because only it asks the operator to act. A count is hidden until the board loads.
 */
export function InboxMenu({ c, view, activeSection, counts, loaded, onSelect }: {
  c: Colors; view: InboxView; activeSection: ActiveSection | null; counts: InboxMenuCounts; loaded: boolean;
  onSelect: (view: InboxView, section?: ActiveSection | null) => void;
}) {
  const count = (id: InboxView) => id === "planning" ? null : counts[id];
  const item = (key: string, label: string, on: boolean, value: number | null, onPress: () => void, options: { icon?: string; hot?: boolean; sub?: boolean } = {}) => (
    <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: on }}
      accessibilityLabel={value === null || !loaded ? label : `${label}, ${value}`} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: options.sub ? 32 : 36, paddingHorizontal: space.sm,
        paddingLeft: options.sub ? space.sm + 16 + space.sm : space.sm, borderRadius: radius.control, backgroundColor: on ? c.surface2 : "transparent" }}>
      {options.icon && <Icon name={options.icon} size={16} color={on ? c.foreground : c.foregroundMuted} />}
      <Text numberOfLines={1} style={{ flex: 1, color: on ? c.foreground : c.foregroundMuted, fontSize: options.sub ? typeScale.metadata.fontSize : typeScale.body.fontSize }}>{label}</Text>
      {value !== null && loaded && (options.hot && value > 0
        ? <View style={{ minWidth: 20, paddingHorizontal: space.xs, borderRadius: radius.panel, backgroundColor: c.accent, alignItems: "center" }}>
            <Text style={{ color: c.accentForeground, fontSize: typeScale.metadata.fontSize, lineHeight: 18, fontWeight: "600" }}>{value}</Text>
          </View>
        : <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{value}</Text>)}
    </Pressable>
  );
  return (
    <ScrollView accessibilityRole="tablist" accessibilityLabel="Nucleus navigation" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: space.xs, gap: 2 }}>
      {inboxViews.map((entry) => <React.Fragment key={entry.id}>
        {item(entry.id, entry.label, view === entry.id && !(entry.id === "active" && activeSection), count(entry.id), () => onSelect(entry.id, null), { icon: entry.icon, hot: entry.id === "needs" })}
        {entry.id === "active" && activeSections.map((section) =>
          item(`active-${section.id}`, section.label, view === "active" && activeSection === section.id, counts.activeBySection[section.id], () => onSelect("active", section.id), { sub: true }))}
        {entry.id === "needs" && <View style={{ height: 1, backgroundColor: c.border, marginVertical: space.xs, marginHorizontal: space.xs }} />}
      </React.Fragment>)}
    </ScrollView>
  );
}
