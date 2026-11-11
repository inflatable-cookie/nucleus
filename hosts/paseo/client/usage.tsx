import React, { useEffect, useState } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import type { ComponentType } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { touchSlop, type Colors } from "../../../client/design";
import {
  PressureRing,
  USAGE_REFRESH_MS,
  bindingWindow,
  dialCaption,
  providerLabel,
  ProviderLogo,
  usageStateWord,
} from "../../../client/usage";
import { usageState } from "../../../shared/contracts";
import type {
  UsagePressureState,
  UsageStateOutput,
  UsageSubscription,
} from "../../../shared/schema/usage";
import { UsagePage } from "../../../client/usage";

/*
 * Spec 059 step 2 (nucleus#1113), the plugin's contributions: the Usage page as
 * its own screen and the compact ring rail in the sidebar, one small ring per
 * subscription (provider mark inside, colour and fill showing the pressure),
 * clicking through to the page. The screen and the custom sidebar item need the
 * host's newer registration APIs (`addScreen`, `addSidebarHeaderItem`), which
 * the 0.9 SDK types this repo pins do not carry; like the agent inventory, the
 * host is read through optional members and the registrations degrade to
 * nothing on older hosts, where the page still lives on the board's navigation.
 */

export const USAGE_SCREEN_ID = "nucleus-usage";
export const USAGE_RAIL_ID = "nucleus-usage-rail";

/** The sidebar item's props: the host's `PluginSidebarItemProps` shape, read leniently. */
export interface UsageRailItemProps {
  theme: { colors: Colors };
  currentScreen?: { screenId: string } | null;
  openScreen?: (input: { screenId: string }) => void;
}

type ScreenComponent = ComponentType<{
  theme: { colors: Colors };
  layout: { compact: boolean };
}>;

/** The host APIs this needs beyond the pinned SDK's types; both may be absent. */
type NewerHostClient = {
  addScreen?: (contribution: {
    id: string;
    title: string;
    Component: ScreenComponent;
  }) => (() => void) | undefined;
  addSidebarHeaderItem?: (contribution: {
    id: string;
    title: string;
    Component: ComponentType<UsageRailItemProps>;
  }) => (() => void) | undefined;
};

/** The screen wrapping the shared Usage page (the page brings its own popover layer). */
export function createUsageScreen(): ScreenComponent {
  return function UsageScreen(props) {
    return (
      <UsagePage
        theme={props.theme}
        layout={{ compact: props.layout.compact }}
      />
    );
  };
}

/** The ring's colour per pressure state: the same mapping the page's dial uses. */
function ringColor(c: Colors, state: UsagePressureState): string {
  switch (state) {
    case "spare":
      return c.statusSuccess;
    case "on_track":
      return c.accent;
    case "will_run_out":
      return c.statusDanger;
    case "unknown":
      return c.foregroundMuted;
  }
}

/** The browser's own focus outline is off; hosts without a DOM need nothing. */
function noOutline(): ViewStyle {
  return (globalThis as { document?: unknown }).document
    ? { outlineWidth: 0, outlineStyle: "none" as ViewStyle["outlineStyle"] }
    : {};
}

/** One subscription's ring: state colour and fill (the binding window's used share), provider mark inside. */
export function UsageRailRing({
  c,
  subscription,
  active,
  onPress,
}: {
  c: Colors;
  subscription: UsageSubscription;
  /** The Usage screen is the host's open screen. */ active: boolean;
  onPress: () => void;
}) {
  const caption = dialCaption(subscription);
  const binding = bindingWindow(subscription);
  const known =
    subscription.projection.state !== "unknown" &&
    subscription.reading.status === "ok";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${providerLabel(subscription.provider)} usage: ${usageStateWord(subscription.projection.state)}${caption === usageStateWord(subscription.projection.state) ? "" : `, ${caption}`}. Opens the usage page`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={touchSlop(22)}
      style={{ alignItems: "center", justifyContent: "center", ...noOutline() }}
    >
      <PressureRing
        size={22}
        thickness={2.5}
        fraction={known && binding ? binding.usedFraction : 0}
        color={ringColor(c, subscription.projection.state)}
        trackColor={c.border}
      >
        <ProviderLogo
          provider={subscription.provider}
          size={11}
          color={known ? c.foreground : c.foregroundMuted}
        />
      </PressureRing>
    </Pressable>
  );
}

/**
 * The sidebar rail item: a row of rings, one per tracked subscription, each
 * opening the Usage screen. Reads `usage.state` itself on the page's slow
 * cadence; a failed read leaves the last rings standing rather than clearing
 * the rail, and nothing renders while no subscription is tracked.
 */
export function createUsageRailItem(client: PluginClientContext) {
  return function UsageRailItem(props: UsageRailItemProps) {
    const c = props.theme.colors;
    const [state, setState] = useState<UsageStateOutput | null>(null);
    useEffect(() => {
      let live = true;
      const read = () => {
        client
          .rpc(usageState, {})
          .then((data) => {
            if (live) setState(data);
          })
          .catch(() => {
            /* the last read stands until the next interval */
          });
      };
      read();
      const timer = setInterval(read, USAGE_REFRESH_MS);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [client]);
    const subscriptions = state?.subscriptions ?? [];
    if (!subscriptions.length) return null;
    const open = () => props.openScreen?.({ screenId: USAGE_SCREEN_ID });
    const active = props.currentScreen?.screenId === USAGE_SCREEN_ID;
    return (
      <View
        accessibilityLabel="Nucleus subscription usage"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 4,
        }}
      >
        {subscriptions.map((subscription) => (
          <UsageRailRing
            key={`${subscription.group}:${subscription.provider}`}
            c={c}
            subscription={subscription}
            active={active}
            onPress={open}
          />
        ))}
      </View>
    );
  };
}

/**
 * Register the Usage screen and the sidebar rail when the host supports them;
 * a no-op remover on hosts that do not, where the board's navigation still
 * carries the page.
 */
export function registerUsageSurfaces(client: PluginClientContext): () => void {
  const host = client as PluginClientContext & NewerHostClient;
  const removers: Array<() => void> = [];
  if (typeof host.addScreen === "function") {
    const remove = host.addScreen({
      id: USAGE_SCREEN_ID,
      title: "Nucleus usage",
      Component: createUsageScreen(),
    });
    if (remove) removers.push(remove);
  }
  if (typeof host.addSidebarHeaderItem === "function") {
    const remove = host.addSidebarHeaderItem({
      id: USAGE_RAIL_ID,
      title: "Nucleus usage",
      Component: createUsageRailItem(client),
    });
    if (remove) removers.push(remove);
  }
  return () => {
    for (const remove of removers) remove();
  };
}
