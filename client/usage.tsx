import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Icon, useRpc, type BoardSurfaceProps } from "./shell";
import {
  HelpTip,
  HelpPopover,
  LabelHelp,
  muted,
  row,
  sectionCard,
  type Colors,
} from "./controls";
import { roles, space, type as typeScale } from "./design";
import {
  formatLocalDateTime,
  formatRelativeSpan,
  formatRelativeTime,
} from "../shared/date-time";
import { errorText } from "./error-text";
import * as api from "../shared/contracts";
import type {
  UsagePressureState,
  UsageProjection,
  UsageSubscription,
  UsageWindow,
} from "../shared/schema/usage";

/*
 * The Usage page (Spec 059 step 2, nucleus#1113): one pressure dial per provider
 * subscription, with each window's details, reached from the board's navigation
 * (never the board header, Tom 2026-11-06). The Paseo sidebar rail imports the
 * dial and ring pieces from here, so both shells draw one gauge. Unknown and
 * not-available states read plainly, never as 0 or green (Tom, 2026-11-11).
 * The page refreshes slowly: the readers themselves read every few minutes, so
 * a minute here adds nothing but keeps the view alive.
 */

/** The page's and the sidebar rail's refresh cadence; deliberately slower than the board. */
export const USAGE_REFRESH_MS = 60_000;

/** The pressure state's word on the page and in the rail's accessible labels. */
export function usageStateWord(state: UsagePressureState): string {
  switch (state) {
    case "will_run_out":
      return "Will run out";
    case "on_track":
      return "On track";
    case "spare":
      return "Spare";
    case "unknown":
      return "Unknown";
  }
}

/** The needle and label colour for a pressure state: green spare, neutral centre, red run-out. */
export function pressureColor(state: UsagePressureState, c: Colors): string {
  const r = roles(c);
  switch (state) {
    case "spare":
      return r.success;
    case "on_track":
      return r.accent;
    case "will_run_out":
      return r.danger;
    case "unknown":
      return r.muted;
  }
}

/**
 * The needle's rotation in degrees for a dial value: −90 points left (spare),
 * 0 up (on track), 90 right (will run out); null when there is no projection.
 */
export function dialNeedleRotation(dial: number | null): number | null {
  if (dial === null) return null;
  return Math.max(-1, Math.min(1, dial)) * 90;
}

/**
 * The short projection label: "+18% over" past 100%, "-30% spare" short of it,
 * "on track" at it; null when the projection cannot say.
 */
export function projectedUseLabel(projection: UsageProjection): string | null {
  const projected = projection.projectedUseAtReset;
  if (projected === null) return null;
  const percent = Math.round((projected - 1) * 100);
  if (Math.abs(percent) <= 2) return "on track";
  return percent > 0 ? `+${percent}% over` : `${percent}% spare`;
}

/**
 * The binding window's short name: "wk" for a week, "5h" for hours, the
 * window's own name when its length cannot say.
 */
export function windowShortLabel(
  window: Pick<UsageWindow, "name" | "windowSeconds">,
): string {
  const seconds = window.windowSeconds;
  if (seconds !== null && seconds > 0) {
    if (seconds >= 6 * 24 * 3_600) return "wk";
    if (seconds >= 3_600) {
      const hours = seconds / 3_600;
      return Number.isInteger(hours)
        ? `${hours}h`
        : `${Math.round(hours * 10) / 10}h`;
    }
    return `${Math.max(1, Math.round(seconds / 60))}m`;
  }
  const name = window.name.toLowerCase();
  if (name.includes("week")) return "wk";
  const hours = /(\d+)\s*-?\s*hour/.exec(name);
  if (hours) return `${hours[1]}h`;
  return name.split(/\s+/).slice(-1)[0]!.slice(0, 8) || "usage";
}

/** The binding window of a subscription's reading, when the projection names one. */
export function bindingWindow(
  subscription: UsageSubscription,
): UsageWindow | null {
  const id = subscription.projection.bindingWindowId;
  if (!id) return null;
  return (
    subscription.reading.windows.find((window) => window.windowId === id) ??
    null
  );
}

/** The dial's caption: the projection label and the binding window, or the plain state. */
export function dialCaption(subscription: UsageSubscription): string {
  const label = projectedUseLabel(subscription.projection);
  if (label === null) return usageStateWord(subscription.projection.state);
  const binding = bindingWindow(subscription);
  return binding ? `${label} · ${windowShortLabel(binding)}` : label;
}

/** "Codex", "Claude", "Grok" — the provider's display name. */
export function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** The icon naming the provider inside the rail's rings. */
export function providerIconName(provider: string): string {
  switch (provider) {
    case "claude":
      return "Sparkles";
    case "grok":
      return "Zap";
    default:
      return "Bot";
  }
}

const dialThickness = 3;

/**
 * The pressure dial: a semicircle with a needle pivoting at the flat edge's
 * centre. Centre is on track, right runs out, left has spare; the needle and
 * hub take the state colour. An unknown projection renders the track only —
 * never a needle that could read as on-track-zero.
 */
export function PressureDial({
  c,
  state,
  dial,
  label,
  size = 128,
}: {
  c: Colors;
  state: UsagePressureState;
  dial: number | null;
  label: string;
  size?: number;
}) {
  const r = roles(c);
  const color = pressureColor(state, c);
  const rotation = dialNeedleRotation(dial);
  const needle = size / 2 - 12;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`Usage dial: ${label}`}
      style={{
        width: size,
        height: size / 2 + space.xs + dialThickness,
        alignItems: "center",
      }}
    >
      <View
        style={{
          width: size,
          height: size / 2,
          borderTopLeftRadius: size / 2,
          borderTopRightRadius: size / 2,
          borderWidth: dialThickness,
          borderBottomWidth: 0,
          borderColor: r.border,
          borderBottomColor: "transparent",
        }}
      />
      {rotation !== null && (
        <View
          // The needle wrapper's centre is the semicircle's centre, so the
          // rotation pivots the line drawn in its upper half.
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: size,
            height: size,
            transform: [{ rotate: `${rotation}deg` }],
          }}
        >
          <View
            style={{
              position: "absolute",
              left: size / 2 - 1.5,
              top: size / 2 - needle,
              width: 3,
              height: needle,
              borderRadius: 1.5,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: size / 2 - 4,
              top: size / 2 - 4,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: color,
            }}
          />
        </View>
      )}
    </View>
  );
}

/**
 * A small ring with an arc fill starting at 12 o'clock, drawn with two
 * half-plane clips over a track circle, so it needs no SVG and renders the
 * same in the plugin, on the web board and on Hermes. `fraction` is the filled
 * share of the circumference.
 */
export function PressureRing({
  size,
  thickness,
  fraction,
  color,
  trackColor,
  children,
}: {
  size: number;
  thickness: number;
  fraction: number;
  color: string;
  trackColor: string;
  children?: React.ReactNode;
}) {
  const half = size / 2;
  const p = Math.max(0, Math.min(1, fraction));
  // First half (right clip): sweeps from 12 o'clock; past half a turn it holds
  // at the full right semicircle and the second half takes over.
  const first = Math.min(360 * p - 135, 45);
  const second = 360 * p - 315;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: thickness,
          borderColor: trackColor,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: half,
          height: size,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            position: "absolute",
            top: 0,
            left: -half,
            width: size,
            height: size,
            borderRadius: half,
            borderWidth: thickness,
            borderTopColor: color,
            borderRightColor: color,
            borderBottomColor: "transparent",
            borderLeftColor: "transparent",
            transform: [{ rotate: `${first}deg` }],
          }}
        />
      </View>
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: half,
          height: size,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: size,
            height: size,
            borderRadius: half,
            borderWidth: thickness,
            borderTopColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: color,
            borderLeftColor: color,
            transform: [{ rotate: `${second}deg` }],
          }}
        />
      </View>
      {children}
    </View>
  );
}

/** One window's detail line: used percent, reset time (relative and absolute), exhaustion when it runs out. */
export function windowDetailLine(
  window: UsageWindow,
  projection: UsageProjection,
  now: number,
): string {
  const parts = [`${Math.round(window.usedFraction * 100)}% used`];
  const reset = formatRelativeTime(window.resetsAt, now);
  if (reset)
    parts.push(`resets ${reset} (${formatLocalDateTime(window.resetsAt!)})`);
  else parts.push("reset time unknown");
  const projected = projection.windows.find(
    (entry) => entry.windowId === window.windowId,
  );
  if (projected?.exhaustsInMs != null) {
    parts.push(
      projected.exhaustsInMs === 0
        ? "exhausted now"
        : `runs out in ${formatRelativeSpan(projected.exhaustsInMs)}`,
    );
  }
  return `${window.name}: ${parts.join(" · ")}`;
}

/** One subscription's freshness line: sample age, source and the next scheduled read. */
export function freshnessLine(
  subscription: UsageSubscription,
  now: number,
): string {
  const parts: string[] = [];
  const sampled = formatRelativeTime(subscription.reading.asOf, now);
  if (sampled) parts.push(`sampled ${sampled}`);
  if (subscription.reading.source) parts.push(subscription.reading.source);
  const next = formatRelativeTime(subscription.nextReadAt, now);
  if (next) parts.push(`next read ${next}`);
  return parts.join(" · ") || "not sampled yet";
}

/** The description behind the card's (?): what the dial means and where the reading came from. */
function cardHelp(subscription: UsageSubscription): string {
  const r = subscription.reading;
  const shape =
    r.status === "ok"
      ? "Centre means the subscription lands at 100% exactly at its reset; right means it runs out first; left means it reaches the reset with usage to spare."
      : "No usable projection for this subscription right now. It is never shown as 0 or green.";
  const source = r.accountId ? ` Reading ${r.accountId}` : "";
  const path = subscription.sourcePath
    ? ` Source path ${subscription.sourcePath}.`
    : "";
  return `${shape}${source}${path}`;
}

/** One subscription's card: dial and caption, window details, freshness and any read error. */
export function UsageCard({
  c,
  compact,
  subscription,
  now,
}: {
  c: Colors;
  compact: boolean;
  subscription: UsageSubscription;
  now: number;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const anchor = React.useRef<View | null>(null);
  const r = roles(c);
  const reading = subscription.reading;
  const projection = subscription.projection;
  const state = projection.state;
  const color = pressureColor(state, c);
  const caption = dialCaption(subscription);
  const heading = `${providerLabel(subscription.provider)} · ${subscription.group}`;
  return (
    <View
      accessibilityLabel={`${heading} usage: ${usageStateWord(state)}${caption === usageStateWord(state) ? "" : `, ${caption}`}`}
      style={{ ...sectionCard(c), gap: space.xs }}
    >
      <View
        ref={anchor}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
      >
        <Icon
          name={providerIconName(subscription.provider)}
          size={16}
          color={c.foreground}
        />
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            color: r.foreground,
            fontWeight: "600",
            fontSize: typeScale.section.fontSize,
            lineHeight: typeScale.section.lineHeight,
            flexShrink: 1,
          }}
        >
          {heading}
        </Text>
        <Text
          style={{
            color,
            fontWeight: "600",
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {usageStateWord(state)}
        </Text>
        <HelpTip
          c={c}
          label={heading}
          text={cardHelp(subscription)}
          open={helpOpen}
          onOpenChange={setHelpOpen}
        />
        {helpOpen && (
          <HelpPopover
            c={c}
            anchor={anchor}
            label={heading}
            text={cardHelp(subscription)}
          />
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: space.sm,
          flexWrap: "wrap",
        }}
      >
        <PressureDial
          c={c}
          state={state}
          dial={projection.dial}
          label={caption}
          size={compact ? 104 : 128}
        />
        <View style={{ gap: 2, paddingBottom: space.xs }}>
          <Text
            accessibilityRole="text"
            style={{
              color,
              fontWeight: "600",
              fontSize: typeScale.body.fontSize,
              lineHeight: typeScale.body.lineHeight,
            }}
          >
            {caption}
          </Text>
          {projection.bindingWindowName && reading.status === "ok" && (
            <Text style={muted(c)}>
              binding window: {projection.bindingWindowName}
            </Text>
          )}
        </View>
      </View>
      {reading.status === "ok" ? (
        <View style={{ gap: 2 }}>
          {reading.windows.map((window) => (
            <Text
              key={window.windowId}
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              {windowDetailLine(window, projection, now)}
            </Text>
          ))}
        </View>
      ) : (
        <Text
          accessibilityRole="text"
          style={{
            color: r.warning,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {reading.status === "not_available" ? "Not available" : "Unknown"}
          {reading.reason ? `: ${reading.reason}` : ""}
        </Text>
      )}
      <Text
        style={{
          ...muted(c),
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
        }}
      >
        {freshnessLine(subscription, now)}
      </Text>
      {subscription.lastError && (
        <Text
          accessibilityRole="text"
          style={{
            color: r.warning,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          Last read failed: {subscription.lastError}
        </Text>
      )}
    </View>
  );
}

/**
 * The Usage page: one card per tracked subscription. Reached from the board's
 * navigation in both shells; the web board serves `usage.state` like any other
 * read. Refreshes on a slow interval — the readers pace themselves, so this
 * adds no fast polling.
 */
export function UsagePage({
  theme,
  layout,
  now: pinnedNow,
}: BoardSurfaceProps & { now?: number }) {
  const c = theme.colors;
  const [width, setWidth] = useState(0);
  const compact = layout.compact || (width > 0 && width < 700);
  const inset = compact ? 16 : 24;
  const fetchUsage = useRpc(api.usageState);
  const usageQuery = useQuery({
    queryKey: ["nucleus", "usage-state"],
    queryFn: () => fetchUsage({}),
    refetchInterval: USAGE_REFRESH_MS,
    retry: false,
  });
  const state = usageQuery.data;
  const now = pinnedNow ?? Date.now();
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: inset,
          paddingTop: inset,
          paddingBottom: inset,
          gap: space.md,
        }}
      >
        <LabelHelp
          c={c}
          label="Usage"
          text="Each provider subscription against its reset: the dial's centre means the subscription lands at 100% exactly at the reset, right means it runs out before it, left means it reaches the reset with usage to spare."
        />
        {usageQuery.error && (
          <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>
            {errorText(usageQuery.error)}
          </Text>
        )}
        {state && state.subscriptions.length === 0 && (
          <Text style={muted(c)}>
            No provider subscription is being tracked. Subscriptions appear once
            a profile group names Codex, Claude or Grok.
          </Text>
        )}
        {(state?.subscriptions ?? []).map((subscription) => (
          <UsageCard
            key={`${subscription.group}:${subscription.provider}`}
            c={c}
            compact={compact}
            subscription={subscription}
            now={now}
          />
        ))}
        {state && (
          <Text
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            Read {formatRelativeTime(state.generatedAt, now) ?? "just now"}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
