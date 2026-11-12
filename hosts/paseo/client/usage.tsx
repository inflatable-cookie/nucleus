import React, { useEffect, useState } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { touchSlop, type Colors, space } from "../../../client/design";
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

/*
 * Spec 059 step 2 (nucleus#1113), the plugin's contribution: one small ring per
 * subscription (provider mark inside, colour and fill showing the pressure),
 * carried in the Nucleus row at the top of the Paseo sidebar and opening the
 * board's Usage tab (nucleus#1123). The page itself is the board's Usage tab, so
 * the web board and the plugin render one screen. The row's host entry is in
 * `./sidebar`; the rings read `usage.state` here.
 */

/** The usage state the row's rings show, read on the page's slow cadence. */
export function useUsageSubscriptions(
  client: PluginClientContext,
): UsageSubscription[] {
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
  return state?.subscriptions ?? [];
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

/**
 * One subscription's ring, counting down: it fills with the binding window's
 * remaining share, so it starts full and empties as the window is used. An
 * unknown or expired reading stays empty and muted. Provider mark inside.
 */
export function UsageRailRing({
  c,
  subscription,
  onPress,
}: {
  c: Colors;
  subscription: UsageSubscription;
  /** Opens the board on its Usage tab. */
  onPress: () => void;
}) {
  const caption = dialCaption(subscription);
  const binding = bindingWindow(subscription);
  const known =
    subscription.projection.state !== "unknown" &&
    subscription.reading.status === "ok" &&
    !subscription.stale?.expired &&
    binding !== null;
  const state = known ? subscription.projection.state : "unknown";
  const remaining = known ? Math.max(0, Math.min(1, 1 - binding!.usedFraction)) : 0;
  const left = known ? `, ${Math.round(remaining * 100)}% left` : "";
  const word = usageStateWord(state);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${providerLabel(subscription.provider)} usage: ${word}${known && caption !== word ? `, ${caption}` : ""}${left}. Opens the usage page`}
      onPress={onPress}
      hitSlop={touchSlop(22)}
      style={{ alignItems: "center", justifyContent: "center", ...noOutline() }}
    >
      <PressureRing
        size={26}
        thickness={2.5}
        fraction={remaining}
        color={ringColor(c, state)}
        trackColor={c.border}
      >
        <ProviderLogo
          provider={subscription.provider}
          size={14}
          color={c.foreground}
        />
      </PressureRing>
    </Pressable>
  );
}

/**
 * The row's rings, one per tracked subscription, in the row's trailing slot.
 * Nothing renders while no subscription is tracked, so the Nucleus button keeps
 * the row to itself.
 */
export function UsageRings({
  c,
  subscriptions,
  onPress,
}: {
  c: Colors;
  subscriptions: UsageSubscription[];
  onPress: () => void;
}) {
  if (!subscriptions.length) return null;
  return (
    <View
      accessibilityLabel="Nucleus subscription usage"
      style={{ flexDirection: "row", alignItems: "center", gap: space.xxs }}
    >
      {subscriptions.map((subscription) => (
        <UsageRailRing
          key={`${subscription.group}:${subscription.provider}`}
          c={c}
          subscription={subscription}
          onPress={onPress}
        />
      ))}
    </View>
  );
}
