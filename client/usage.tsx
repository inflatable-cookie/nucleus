import React, { useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
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
import { PopoverHost } from "./popover";
import {
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
import { providerLogoSource } from "./provider-logo-assets";

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

/** A customer-facing name for a provider window, never its internal ID. */
export function friendlyWindowName(window: UsageWindow): string {
  if (/credit|billing/i.test(window.name)) return "Billing period";
  const seconds = window.windowSeconds;
  if (seconds !== null) {
    if (seconds >= 6 * 24 * 3_600) return "This week";
    if (seconds >= 3_600 && seconds < 24 * 3_600) {
      const hours = Math.max(1, Math.round(seconds / 3_600));
      return `Next ${hours} ${hours === 1 ? "hour" : "hours"}`;
    }
  }
  return window.name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The reset day used in sentences and the window row. */
export function resetDay(iso: string | null): string | null {
  const date = resetDate(iso);
  return date ? weekdays[date.getDay()]! : null;
}

/** A reset instant rounded to the nearest minute, so 08:59:59 reads as 09:00. */
function resetDate(iso: string | null): Date | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(Math.round(at / 60_000) * 60_000);
}

/** The window row's reset label: "Resets Saturday 09:00". */
export function resetLabel(iso: string | null): string {
  const date = resetDate(iso);
  if (!date) return "Reset time unavailable";
  return `Resets ${weekdays[date.getDay()]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Projected use at reset at or below this reads "Plenty of room"; above it, "On track". */
export const PLENTY_OF_ROOM_MAX = 0.8;

/** Plain-language verdict for the subscription's projected pressure. */
export function usageVerdict(
  subscription: UsageSubscription,
  now: number,
): string {
  const { projection, reading, stale } = subscription;
  if (
    projection.state === "unknown" ||
    stale?.expired ||
    reading.status !== "ok"
  )
    return "Usage unavailable right now.";
  const window = bindingWindow(subscription);
  const day = resetDay(window?.resetsAt ?? null);
  if (!window || !day) return "Usage unavailable right now.";
  const reset = Date.parse(window.resetsAt!);
  if (projection.state === "will_run_out") {
    const projected = projection.windows.find(
      (entry) => entry.windowId === window.windowId,
    );
    if (projected?.exhaustsInMs == null)
      return `At this pace you'll run out before ${day}'s reset.`;
    const runsOutAt = new Date(now + projected.exhaustsInMs);
    const timeOfDay =
      runsOutAt.getHours() < 12
        ? "morning"
        : runsOutAt.getHours() < 17
          ? "afternoon"
          : runsOutAt.getHours() < 21
            ? "evening"
            : "tonight";
    const daysBefore = Math.round(
      (reset - runsOutAt.getTime()) / (24 * 3_600_000),
    );
    const lead =
      daysBefore >= 1
        ? `about ${daysBefore} day${daysBefore === 1 ? "" : "s"} before`
        : "shortly before";
    return `At this pace you'll run out ${weekdays[runsOutAt.getDay()]} ${timeOfDay}, ${lead} ${day}'s reset.`;
  }
  const projectedUse = projection.projectedUseAtReset;
  if (projectedUse === null) return "Usage unavailable right now.";
  if (projection.state === "on_track" || projectedUse > PLENTY_OF_ROOM_MAX) {
    const spare = Math.max(0, Math.round((1 - projectedUse) * 100));
    return `On track. You should reach ${day}'s reset with about ${spare}% to spare.`;
  }
  return `Plenty of room. On track to use about ${Math.round(projectedUse * 100)}% by ${day}'s reset.`;
}

/** Fraction of a known window that has elapsed, for the bar's on-pace marker. */
export function windowElapsedFraction(
  window: UsageWindow,
  now: number,
): number | null {
  if (!window.resetsAt) return null;
  const reset = Date.parse(window.resetsAt);
  const length =
    window.windowSeconds !== null
      ? window.windowSeconds * 1000
      : window.windowStartsAt
        ? reset - Date.parse(window.windowStartsAt)
        : NaN;
  if (
    !Number.isFinite(reset) ||
    !Number.isFinite(length) ||
    length <= 0 ||
    reset <= now ||
    reset - length > now
  )
    return null;
  return Math.max(0, Math.min(1, (now - (reset - length)) / length));
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

/** A bundled provider mark; unknown providers keep the existing generic icon. */
export function ProviderLogo({
  provider,
  size,
  color,
}: {
  provider: string;
  size: number;
  color: string;
}) {
  const source = providerLogoSource(provider);
  if (!source) {
    return <Icon name={providerIconName(provider)} size={size} color={color} />;
  }
  return (
    <Image
      accessibilityRole="image"
      accessibilityLabel={`${providerLabel(provider)} logo`}
      source={{ uri: source }}
      resizeMode="contain"
      style={{ width: size, height: size, tintColor: color }}
    />
  );
}

/** The card title omits a group name that only repeats its provider. */
export function usageCardHeading(provider: string, group: string): string {
  const label = providerLabel(provider);
  return group.trim().toLowerCase() === provider.trim().toLowerCase()
    ? label
    : `${label} · ${group}`;
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
  // Strokes scale with the dial so the card's large dial keeps its weight.
  const track = Math.max(dialThickness, Math.round(size / 32));
  const stroke = Math.max(3, Math.round(size / 44));
  const hub = Math.max(8, Math.round(size / 16));
  const needle = size / 2 - 12 - track;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`Usage dial: ${label}`}
      style={{
        width: size,
        height: size / 2 + space.xs + track,
        alignItems: "center",
      }}
    >
      <View
        style={{
          width: size,
          height: size / 2,
          borderTopLeftRadius: size / 2,
          borderTopRightRadius: size / 2,
          borderWidth: track,
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
              left: size / 2 - stroke / 2,
              top: size / 2 - needle,
              width: stroke,
              height: needle,
              borderRadius: stroke / 2,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: size / 2 - hub / 2,
              top: size / 2 - hub / 2,
              width: hub,
              height: hub,
              borderRadius: hub / 2,
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
 * share of the circumference; at 0 only the track shows.
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
  // at the full right semicircle and the second half takes over. The second
  // half mounts only past half a turn: below it its rotation would paint a
  // spurious arc into the left clip (at 0, the whole left semicircle).
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
      {p > 0.5 && (
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
      )}
      {children}
    </View>
  );
}

/** The description behind the card's (?): what the dial means and where the reading came from. */
function cardHelp(subscription: UsageSubscription, now: number): string {
  const r = subscription.reading;
  const shape =
    r.status === "ok"
      ? "Centre means the subscription lands at 100% exactly at its reset; right means it runs out first; left means it reaches the reset with usage to spare."
      : "No usable projection for this subscription right now. It is never shown as 0 or green.";
  const reason = r.reason ? ` ${r.reason}` : "";
  const source = ` Sampled ${formatRelativeTime(r.asOf, now) ?? "at an unknown time"} via ${r.source}.${r.accountId ? ` Account ${r.accountId}.` : ""}`;
  const next = subscription.nextReadAt
    ? ` Next read ${formatRelativeTime(subscription.nextReadAt, now) ?? "unknown"}.`
    : "";
  const pace = subscription.projection.windows.find(
    (entry) => entry.windowId === subscription.projection.bindingWindowId,
  )?.pace;
  const paceDetail =
    pace === null || pace === undefined
      ? ""
      : ` Projected pace ${Math.round(pace * 100)}% of an even pace.`;
  const path = subscription.sourcePath
    ? ` Source path ${subscription.sourcePath}.`
    : "";
  return `${shape}${reason}${source}${next}${paceDetail}${path}`;
}

/** A window row with used amount and the elapsed-time marker for on pace. */
function UsageWindowRow({
  c,
  window,
  now,
  expired,
  color,
}: {
  c: Colors;
  window: UsageWindow;
  now: number;
  expired: boolean;
  /** The subscription's state colour; the used portion takes it, the pace marker stays neutral. */
  color: string;
}) {
  const r = roles(c);
  const used = Math.round(window.usedFraction * 100);
  const elapsed = windowElapsedFraction(window, now);
  const reset = resetLabel(window.resetsAt);
  return (
    <View
      style={{ gap: 4 }}
      accessibilityLabel={`${friendlyWindowName(window)}. ${reset}. ${used}% used${expired ? ". Expired" : ""}`}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: space.xs,
        }}
      >
        <Text
          style={{
            color: r.foreground,
            fontSize: typeScale.metadata.fontSize,
            fontWeight: "600",
          }}
        >
          {friendlyWindowName(window)}{expired ? " · expired" : ""}
        </Text>
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{reset}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`${used}% used${elapsed === null ? "" : `; ${Math.round(elapsed * 100)}% of the window elapsed`}`}
          style={{
            height: 6,
            flex: 1,
            borderRadius: 3,
            backgroundColor: r.border,
            overflow: "visible",
            position: "relative",
          }}
        >
          <View
            testID="usage-used-bar"
            style={{ height: 6, width: `${Math.max(0, Math.min(100, used))}%`, borderRadius: 3, backgroundColor: color }}
          />
          {elapsed !== null && (
            <View
              testID="usage-pace-marker"
              style={{
                position: "absolute",
                left: `${elapsed * 100}%`,
                top: -3,
                width: 1,
                height: 12,
                backgroundColor: r.foreground,
              }}
            />
          )}
        </View>
        <Text style={{ color: r.foreground, fontSize: typeScale.metadata.fontSize }}>{used}% used</Text>
      </View>
    </View>
  );
}

/** Below this card width the dial stacks above the content column. */
export const USAGE_CARD_STACK_WIDTH = 460;

/** The card's dial width: about twice the earlier 88 px dial. */
export const USAGE_CARD_DIAL_SIZE = 176;

/**
 * One subscription's card: a large dial on the left, vertically centred, and
 * one column to its right with the header, verdict, window rows and any stale
 * note. Narrow cards stack the dial above the column.
 */
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
  const [width, setWidth] = useState(0);
  const anchor = React.useRef<View | null>(null);
  const r = roles(c);
  const reading = subscription.reading;
  const projection = subscription.projection;
  const state = subscription.stale?.expired ? "unknown" : projection.state;
  const color = pressureColor(state, c);
  const heading = providerLabel(subscription.provider);
  const verdict = usageVerdict(subscription, now);
  const caption = state === "unknown" ? usageStateWord(state) : dialCaption(subscription);
  const stacked = width > 0 && width < USAGE_CARD_STACK_WIDTH;
  const dialSize = compact ? 152 : USAGE_CARD_DIAL_SIZE;
  return (
    <View
      accessibilityLabel={`${heading} usage: ${verdict}`}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        ...sectionCard(c),
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "flex-start" : "center",
        gap: space.md,
      }}
    >
      <PressureDial
        c={c}
        state={state}
        dial={state === "unknown" ? null : projection.dial}
        label={caption}
        size={dialSize}
      />
      <View
        testID="usage-card-column"
        style={{
          gap: space.xs,
          flex: stacked ? undefined : 1,
          alignSelf: stacked ? "stretch" : undefined,
          minWidth: 0,
        }}
      >
        <View
          ref={anchor}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
        >
          <ProviderLogo
            provider={subscription.provider}
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
          <HelpTip
            c={c}
            label={heading}
            text={cardHelp(subscription, now)}
            open={helpOpen}
            onOpenChange={setHelpOpen}
          />
          {helpOpen && (
            <HelpPopover
              c={c}
              anchor={anchor}
              label={heading}
              text={cardHelp(subscription, now)}
            />
          )}
        </View>
        <Text
          accessibilityRole="text"
          style={{
            color: r.foreground,
            fontWeight: "600",
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {verdict}
        </Text>
        {reading.status === "ok" ? (
          <View style={{ gap: space.xs, marginTop: 2 }}>
            {reading.windows.map((window) => (
              <UsageWindowRow
                key={window.windowId}
                c={c}
                window={window}
                now={now}
                expired={Boolean(subscription.stale?.expired)}
                color={color}
              />
            ))}
          </View>
        ) : null}
        {subscription.stale && (
          <Text
            accessibilityRole="text"
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            Showing the reading from {formatRelativeSpan(subscription.stale.ageMs)} ago: couldn't refresh ({subscription.stale.reason})
          </Text>
        )}
        {!subscription.stale && now - Date.parse(reading.asOf) > 60 * 60_000 && (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            updated {formatRelativeTime(reading.asOf, now)}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * The Usage page: one card per tracked subscription. Reached from the board's
 * navigation in both shells and mounted as the plugin's own Usage screen; the
 * page brings its own popover layer, so its (?) explanations draw above the
 * cards wherever it mounts. The web board serves `usage.state` like any other
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
    <PopoverHost>
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
              No provider subscription is being tracked. Subscriptions appear
              once a profile group names Codex, Claude or Grok.
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
        </ScrollView>
      </View>
    </PopoverHost>
  );
}
