import React, { useState } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import type { ComponentType } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { radius, space, type as typeScale, type Colors } from "../../../client/design";
import { useFocusVisible } from "../../../client/focus-modality";
import { MainSurface, requestBoardTab } from "../../../client/queue";
import type { BoardNavigation } from "../../../client/shell/types";
import { paseoShell } from "./shell";
import { UsageRings, useUsageSubscriptions } from "./usage";

/*
 * Nucleus in the Paseo sidebar (nucleus#1123). On hosts that carry the newer
 * registration APIs the board is one of the host's screens and the sidebar's one
 * Nucleus row carries both the board button (left) and the usage rings (right,
 * opening the board's Usage tab); the native sidebar item is then not registered,
 * so nothing appears twice. Hosts without those APIs keep the native item and get
 * no rings. The row is built from the host theme and the board's own design scale,
 * matching Paseo's native item (a 36pt row, 44pt on compact layouts, the icon at
 * 20pt, the label at body size, a raised-surface highlight for hover and the open
 * screen, the muted text colour until then).
 */

/** The board as a host screen, so the sidebar row can open it. */
export const BOARD_SCREEN_ID = "nucleus";
/** The one sidebar row: the board button and the usage rings. */
export const BOARD_ROW_ID = "nucleus";

/** The row's props: the host's `PluginSidebarItemProps` shape, read leniently. */
export interface NucleusSidebarRowProps {
  theme: { colors: Colors };
  layout?: { compact?: boolean };
  /** The plugin screen open on this host, or null. */
  currentScreen?: { screenId: string } | null;
  openScreen?: (input: { screenId: string }) => void;
}

type BoardScreenComponent = ComponentType<{
  theme: { colors: Colors };
  layout: { compact: boolean };
  /** Host navigation (open an agent, a workspace); absent on hosts that carry none. */
  navigation?: BoardNavigation;
}>;

/** The host APIs this needs beyond the pinned SDK's types; both may be absent. */
type NewerHostClient = {
  addScreen?: (contribution: {
    id: string;
    title: string;
    Component: BoardScreenComponent;
  }) => (() => void) | undefined;
  addSidebarHeaderItem?: (contribution: {
    id: string;
    title: string;
    Component: ComponentType<NucleusSidebarRowProps>;
  }) => (() => void) | undefined;
};

/** The board screen: the shared board surface, tabs and all. */
export function createBoardScreen(): BoardScreenComponent {
  return function NucleusBoardScreen(props) {
    return (
      <MainSurface
        theme={props.theme}
        layout={props.layout}
        navigation={props.navigation}
      />
    );
  };
}

/** Paseo's row highlight when the host theme carries it; the theme's raised surface otherwise. */
function highlightColor(c: Colors): string {
  return (c as Colors & { readonly surfaceSidebarHover?: string })
    .surfaceSidebarHover ?? c.surface2;
}

/** The browser's own focus outline is off; hosts without a DOM need nothing. */
function noOutline(): ViewStyle {
  return (globalThis as { document?: unknown }).document
    ? { outlineWidth: 0, outlineStyle: "none" as ViewStyle["outlineStyle"] }
    : {};
}

/**
 * The Nucleus row: a button (board icon and title) on the left and the usage
 * rings on the right. The button opens the board and shows Paseo's highlight
 * while the board is the open screen; each ring opens the board on its Usage tab.
 */
export function createNucleusSidebarRow(client: PluginClientContext) {
  return function NucleusSidebarRow(props: NucleusSidebarRowProps) {
    const c = props.theme.colors;
    const compact = props.layout?.compact ?? false;
    const subscriptions = useUsageSubscriptions(client);
    const [hover, setHover] = useState(false);
    const [pressed, setPressed] = useState(false);
    const focus = useFocusVisible();
    const active = props.currentScreen?.screenId === BOARD_SCREEN_ID;
    const highlighted = hover || active;
    const openBoard = () => props.openScreen?.({ screenId: BOARD_SCREEN_ID });
    const openUsage = () => {
      requestBoardTab("usage");
      openBoard();
    };
    return (
      <View
        accessibilityLabel="Nucleus sidebar row"
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        style={{
          width: "100%",
          flexDirection: "row",
          alignItems: "center",
          borderRadius: radius.card,
          backgroundColor: pressed
            ? c.surface2
            : highlighted
              ? highlightColor(c)
              : "transparent",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Nucleus"
          accessibilityState={{ selected: active }}
          onPress={openBoard}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          onFocus={focus.onFocus}
          onBlur={focus.onBlur}
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            minHeight: compact ? 44 : 36,
            paddingVertical: space.xxs,
            paddingHorizontal: space.xs,
            borderRadius: radius.card,
            ...noOutline(),
          }}
        >
          {focus.visible && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                borderRadius: radius.card,
                borderWidth: 2,
                borderColor: c.foreground,
              }}
            />
          )}
          <paseoShell.Icon
            name="ListTodo"
            size={compact ? 18 : 20}
            color={highlighted ? c.foreground : c.foregroundMuted}
          />
          <Text
            numberOfLines={1}
            style={{
              color: highlighted ? c.foreground : c.foregroundMuted,
              fontSize: typeScale.body.fontSize,
              lineHeight: typeScale.body.lineHeight,
              flexShrink: 1,
            }}
          >
            Nucleus
          </Text>
        </Pressable>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xxs,
            paddingRight: space.xs,
          }}
        >
          <UsageRings c={c} subscriptions={subscriptions} onPress={openUsage} />
        </View>
      </View>
    );
  };
}

/**
 * Register the board screen and the one Nucleus row on hosts that carry both
 * newer APIs. `combined` is false on older hosts, which keep Paseo's native
 * sidebar item and render no rings.
 */
export function registerNucleusSidebar(client: PluginClientContext): {
  combined: boolean;
  remove: () => void;
} {
  const host = client as PluginClientContext & NewerHostClient;
  if (
    typeof host.addScreen !== "function" ||
    typeof host.addSidebarHeaderItem !== "function"
  ) {
    return { combined: false, remove: () => {} };
  }
  const removers: Array<() => void> = [];
  const removeScreen = host.addScreen({
    id: BOARD_SCREEN_ID,
    title: "Nucleus",
    Component: createBoardScreen(),
  });
  if (removeScreen) removers.push(removeScreen);
  const removeRow = host.addSidebarHeaderItem({
    id: BOARD_ROW_ID,
    title: "Nucleus",
    Component: createNucleusSidebarRow(client),
  });
  if (removeRow) removers.push(removeRow);
  return {
    combined: true,
    remove: () => {
      for (const remove of removers) remove();
    },
  };
}
