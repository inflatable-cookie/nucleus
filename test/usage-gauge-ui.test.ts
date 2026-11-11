import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { projectUsage } from "../shared/usage-projection";
import type { UsageProjectionWindow } from "../shared/usage-projection";
import {
  usageStateOutputSchema,
  type UsageStateOutput,
} from "../shared/schema/usage";

// Spec 059 step 2 (nucleus#1113): the Usage page's pressure dial maps state and
// value correctly; the page renders subscriptions from a `usage.state` fixture;
// the sidebar rail renders and links to the page; the plugin shell renders the
// page from the board's navigation. Synthetic fixtures only. The web shell is
// exercised by test/web-shell.test.ts against the built bundle.
useNativeStubs();
type UsageModule = typeof import("../client/usage");
type HostModule = typeof import("../hosts/paseo/client/usage");
let usage: UsageModule;
let hostUsage: HostModule;
const load = async () => {
  usage = await import("../client/usage");
  hostUsage = await import("../hosts/paseo/client/usage");
  return usage;
};

const h = React.createElement;
/** Dark-theme palette: every themed style resolves to one of these tokens. */
const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusSuccess: "#3fb950",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
} as const;
const c = dark as never;
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const AT = "2026-11-11T12:00:00.000Z";
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
// A week resetting Saturday noon: Wednesday noon is 4/7 of the window in.
const RESET = Date.parse("2026-11-14T12:00:00.000Z");

function window(
  overrides: Partial<UsageProjectionWindow> = {},
): UsageProjectionWindow {
  return {
    windowId: "weekly",
    name: "Weekly",
    usedFraction: 0.5,
    windowSeconds: WEEK / 1000,
    windowStartsAt: null,
    resetsAt: new Date(RESET).toISOString(),
    ...overrides,
  };
}

const reading = (windows: unknown[], source = "app-server") => ({
  status: "ok",
  reason: null,
  asOf: AT,
  source,
  accountId: "acc-1",
  windows,
});

const subscription = (over: {
  group?: string;
  provider?: "codex" | "claude" | "grok";
  reading: unknown;
  projection: unknown;
  lastError?: string | null;
  nextReadAt?: string | null;
}) =>
  usageStateOutputSchema.parse({
    generatedAt: AT,
    subscriptions: [
      {
        group: over.group ?? "codex-main",
        provider: over.provider ?? "codex",
        profileIds: ["worker"],
        sourcePath: null,
        reading: over.reading,
        projection: over.projection,
        nextReadAt: over.nextReadAt ?? new Date(NOW + 5 * 60_000).toISOString(),
        lastAttemptAt: AT,
        lastError: over.lastError ?? null,
      },
    ],
  }).subscriptions[0];

/** The fixture state the page and rail render: every pressure state once. */
function fixtureState(): UsageStateOutput {
  const runningOut = projectUsage({
    now: NOW,
    windows: [window({ usedFraction: 0.62 })],
  });
  const spare = projectUsage({
    now: NOW,
    windows: [window({ usedFraction: 0.25 })],
  });
  const onTrack = projectUsage({
    now: NOW,
    windows: [window({ usedFraction: 4 / 7 })],
  });
  // Grok's single credit gauge over its billing period, projecting on track.
  const credits = {
    windowId: "credits",
    name: "Credits",
    usedFraction: 4 / 7,
    windowSeconds: WEEK / 1000,
    windowStartsAt: null,
    resetsAt: new Date(RESET).toISOString(),
  };
  const creditsProjection = projectUsage({ now: NOW, windows: [credits] });
  const pinned = projectUsage({
    now: NOW,
    windows: [window({ windowId: "full", name: "Weekly", usedFraction: 1 })],
  });
  return usageStateOutputSchema.parse({
    generatedAt: AT,
    subscriptions: [
      {
        group: "codex-main",
        provider: "codex",
        profileIds: ["worker"],
        sourcePath: null,
        reading: reading([window({ usedFraction: 0.62 })]),
        projection: runningOut,
        nextReadAt: new Date(NOW + 5 * 60_000).toISOString(),
        lastAttemptAt: AT,
        lastError: null,
      },
      {
        group: "claude-main",
        provider: "claude",
        profileIds: ["worker"],
        sourcePath: null,
        reading: reading([window({ usedFraction: 0.25 })], "cache"),
        projection: spare,
        nextReadAt: new Date(NOW + 5 * 60_000).toISOString(),
        lastAttemptAt: AT,
        lastError: null,
      },
      {
        group: "grok-main",
        provider: "grok",
        profileIds: ["worker"],
        sourcePath: null,
        reading: reading([credits], "cli"),
        projection: creditsProjection,
        nextReadAt: null,
        lastAttemptAt: AT,
        lastError: null,
      },
      {
        group: "codex-backup",
        provider: "codex",
        profileIds: ["worker"],
        sourcePath: null,
        reading: {
          status: "unknown",
          reason: "codex usage read failed: app-server not reachable",
          asOf: AT,
          source: "rollout",
          accountId: null,
          windows: [],
        },
        projection: {
          state: "unknown",
          bindingWindowId: null,
          bindingWindowName: null,
          projectedUseAtReset: null,
          dial: null,
          windows: [],
        },
        nextReadAt: new Date(NOW + 60 * 60_000).toISOString(),
        lastAttemptAt: AT,
        lastError: "app-server not reachable",
      },
      {
        group: "claude-second",
        provider: "claude",
        profileIds: ["worker"],
        sourcePath: null,
        reading: {
          status: "not_available",
          reason: "no cached usage for this subscription",
          asOf: AT,
          source: "cache",
          accountId: null,
          windows: [],
        },
        projection: {
          state: "unknown",
          bindingWindowId: null,
          bindingWindowName: null,
          projectedUseAtReset: null,
          dial: null,
          windows: [],
        },
        nextReadAt: null,
        lastAttemptAt: null,
        lastError: null,
      },
    ],
  });
}

const fixture = {
  state: fixtureState(),
  subscriptions: fixtureState().subscriptions,
};
const invokeWith =
  (state: UsageStateOutput) => async (method: string, input: unknown) => {
    if (method === "usage.state") return state;
    void input;
    return {};
  };

/** Mounts the page alone under the plugin shell's providers, at the fixture's own clock. */
function mountPage(state: UsageStateOutput) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invokeWith(state),
        children: h(usage.UsagePage as never, {
          theme: { colors: c },
          layout: { compact: false },
          now: NOW,
        }),
      }),
    }),
  );
}

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the surface did not settle");
}

/** The needle wrapper: the one dial View carrying a rotate transform. */
function needleOf(tree: ReturnType<typeof mount>): HostNode | undefined {
  return tree
    .ofType("View")
    .find(
      (node) =>
        Array.isArray(node.props.style?.transform) &&
        node.props.style.transform.some(
          (entry: { rotate?: string }) => typeof entry?.rotate === "string",
        ),
    );
}

test("the dial maps state and value: centre, left, right, pinned, unknown", async () => {
  await load();
  assert.equal(usage.dialNeedleRotation(0), 0, "centre is upright");
  assert.equal(usage.dialNeedleRotation(-1), -90, "full spare points left");
  assert.equal(usage.dialNeedleRotation(1), 90, "full run-out points right");
  assert.equal(
    usage.dialNeedleRotation(4),
    90,
    "a pinned dial clamps to the right stop",
  );
  assert.equal(
    usage.dialNeedleRotation(null),
    null,
    "no projection has no needle",
  );

  const centre = mount(
    h(usage.PressureDial, { c, state: "on_track", dial: 0, label: "on track" }),
  );
  assert.match(
    needleOf(centre)!.props.style.transform[0].rotate,
    /^0deg$/,
    "centre needle sits upright",
  );
  const left = mount(
    h(usage.PressureDial, { c, state: "spare", dial: -1, label: "-30% spare" }),
  );
  assert.equal(needleOf(left)!.props.style.transform[0].rotate, "-90deg");
  const right = mount(
    h(usage.PressureDial, {
      c,
      state: "will_run_out",
      dial: 1,
      label: "+18% over",
    }),
  );
  const rightNeedle = needleOf(right)!;
  assert.equal(rightNeedle.props.style.transform[0].rotate, "90deg");
  // The needle takes the state colour: red right, green left, muted unknown.
  const line = (node: HostNode) =>
    node.children.find((child) => typeof child !== "string") as HostNode;
  assert.equal(
    line(rightNeedle).props.style.backgroundColor,
    dark.statusDanger,
  );
  assert.equal(
    line(needleOf(left)!).props.style.backgroundColor,
    dark.statusSuccess,
  );
  const unknown = mount(
    h(usage.PressureDial, {
      c,
      state: "unknown",
      dial: null,
      label: "Unknown",
    }),
  );
  assert.equal(
    needleOf(unknown),
    undefined,
    "an unknown state renders no needle at all",
  );
});

test("the rail ring paints only the used share: empty at fraction 0, full at 1", async () => {
  await load();
  // The two half-plane clips are the ring's only overflow-hidden Views; the
  // left one mounts only past half a turn, so an empty ring (an unknown
  // subscription's fill) never shows a painted arc (review 1113).
  const clips = (tree: ReturnType<typeof mount>) =>
    tree
      .ofType("View")
      .filter((node) => node.props.style?.overflow === "hidden")
      .map((node) => (node.props.style.left === 0 ? "left" : "right"));
  const empty = mount(
    h(usage.PressureRing, {
      size: 22,
      thickness: 2.5,
      fraction: 0,
      color: dark.foregroundMuted,
      trackColor: dark.border,
    }),
  );
  assert.deepEqual(clips(empty), ["right"], "fraction 0 mounts no left half");
  const quarter = mount(
    h(usage.PressureRing, {
      size: 22,
      thickness: 2.5,
      fraction: 0.25,
      color: dark.statusDanger,
      trackColor: dark.border,
    }),
  );
  assert.deepEqual(clips(quarter), ["right"], "a quarter fill still mounts no left half");
  const threeQuarters = mount(
    h(usage.PressureRing, {
      size: 22,
      thickness: 2.5,
      fraction: 0.75,
      color: dark.statusDanger,
      trackColor: dark.border,
    }),
  );
  assert.deepEqual(clips(threeQuarters), ["right", "left"], "past half a turn both halves mount");
  const full = mount(
    h(usage.PressureRing, {
      size: 22,
      thickness: 2.5,
      fraction: 1,
      color: dark.statusDanger,
      trackColor: dark.border,
    }),
  );
  assert.deepEqual(clips(full), ["right", "left"], "a full ring mounts both halves");
});

test("labels and short window names read as the brief writes them", async () => {
  await load();
  const label = (projected: number | null) =>
    usage.projectedUseLabel({
      state: "spare",
      bindingWindowId: null,
      bindingWindowName: null,
      projectedUseAtReset: projected,
      dial: null,
      windows: [],
    });
  assert.equal(label(1.18), "+18% over");
  assert.equal(label(0.7), "-30% spare");
  assert.equal(label(1), "on track");
  assert.equal(label(null), null);
  assert.equal(
    usage.windowShortLabel({ name: "Weekly", windowSeconds: WEEK / 1000 }),
    "wk",
  );
  assert.equal(
    usage.windowShortLabel({ name: "five_hour", windowSeconds: 5 * 3600 }),
    "5h",
  );
  assert.equal(
    usage.windowShortLabel({ name: "5-hour", windowSeconds: null }),
    "5h",
  );
  assert.equal(
    usage.windowShortLabel({ name: "Weekly", windowSeconds: null }),
    "wk",
  );
  assert.equal(usage.usageStateWord("will_run_out"), "Will run out");
  assert.equal(usage.usageStateWord("unknown"), "Unknown");
});

test("the page renders subscriptions from a fixture usage.state", async () => {
  await load();
  const tree = mountPage(fixture.state);
  const over = Math.round(
    (fixture.subscriptions[0]!.projection.projectedUseAtReset! - 1) * 100,
  );
  await settle(() => tree.text().includes("Codex · codex-main"));
  const text = tree.text();

  // Each card names its provider and group, the state, and the dial caption
  // with the projected use at reset and the binding window ("wk").
  assert.ok(text.includes("Codex · codex-main"), "the codex card renders");
  const pageLogos = tree.ofType("Image").map((node) => node.props.accessibilityLabel);
  for (const provider of ["Claude", "Codex", "Grok"]) {
    assert.ok(pageLogos.includes(`${provider} logo`), `${provider} logo renders on the page`);
  }
  assert.ok(text.includes("Will run out"));
  assert.ok(
    new RegExp(`\\+${over}% over · wk`).test(text),
    `the caption carries +${over}% over · wk`,
  );
  assert.ok(
    text.includes("-63% spare · wk") || /-\d+% spare · wk/.test(text),
    "the spare card shows its spare",
  );
  assert.ok(
    text.includes("binding window: Weekly"),
    "the binding window is named",
  );

  // Window details: used percent, reset time relative and absolute, exhaustion.
  assert.match(text, /Weekly: 62% used · resets in .+ \(.*\) · runs out in .+/);
  assert.match(
    text,
    /sampled just now · app-server · next read in 5m/,
    "freshness names age, source and next read",
  );

  // Unknown and not available say so plainly, never 0 or green.
  assert.match(
    text,
    /Unknown: codex usage read failed: app-server not reachable/,
  );
  assert.match(text, /Not available: no cached usage for this subscription/);
  assert.ok(
    !text.includes("0% used · reset time unknown · "),
    "a broken subscription never reads as an empty window",
  );
  assert.ok(
    text.includes("Last read failed: app-server not reachable"),
    "the stored read error shows",
  );
});

test("the sidebar rail renders rings per subscription and links to the page", async () => {
  await load();
  const opened: Array<{ screenId: string }> = [];
  // The fake client mirrors the plugin's rpc: the caller hands the contract, the
  // invoke receives its name.
  const invoke = invokeWith(fixture.state);
  const client = {
    rpc: (contract: { name: string }, input: unknown) =>
      invoke(contract.name, input),
  } as never;
  const RailItem = hostUsage.createUsageRailItem(client);
  const tree = mount(
    h(RailItem, {
      theme: { colors: c },
      currentScreen: null,
      openScreen: (input: { screenId: string }) => {
        opened.push(input);
      },
    }),
  );
  await settle(
    () => tree.all(/usage: /).length === fixture.subscriptions.length,
  );
  const railLogos = tree.ofType("Image").map((node) => node.props.accessibilityLabel);
  for (const provider of ["Claude", "Codex", "Grok"]) {
    assert.ok(railLogos.includes(`${provider} logo`), `${provider} logo renders in the rail`);
  }
  const railSvgMarks = tree.ofType("Image").map((node) =>
    decodeURIComponent(node.props.source.uri.split(",")[1]),
  );
  assert.ok(
    railSvgMarks.every((svg) => svg.includes(`fill="${dark.foreground}"`)),
    "rail marks use the theme text colour regardless of reading state",
  );
  const labels = tree
    .all(/usage: /)
    .map((node) => node.props.accessibilityLabel as string);
  assert.ok(
    labels.some((label) => label.startsWith("Codex usage: Will run out")),
    "the run-out ring names its state",
  );
  assert.ok(
    labels.some((label) => label.startsWith("Claude usage: Spare")),
    "the spare ring names its state",
  );
  assert.ok(
    labels.every((label) => label.endsWith("Opens the usage page")),
    "every ring says where it leads",
  );
  const ring = tree.query(/^Codex usage: /)!;
  ring.props.onPress();
  assert.deepEqual(
    opened,
    [{ screenId: hostUsage.USAGE_SCREEN_ID }],
    "pressing a ring opens the Usage screen",
  );
});

test("provider logos fall back for unknown providers and titles omit duplicate groups", async () => {
  await load();
  assert.equal(usage.usageCardHeading("claude", "claude"), "Claude");
  assert.equal(usage.usageCardHeading("claude", "Claude"), "Claude");
  assert.equal(usage.usageCardHeading("claude", "work"), "Claude · work");

  const fallback = mount(
    h(usage.ProviderLogo, { provider: "unknown", size: 12, color: dark.foreground }),
  );
  const icon = fallback.ofType("Icon")[0];
  assert.equal(icon?.props.name, "Bot");
  assert.equal(icon?.props.color, dark.foreground);

  for (const provider of ["claude", "codex", "grok"]) {
    const logo = mount(
      h(usage.ProviderLogo, { provider, size: 12, color: dark.foreground }),
    ).ofType("Image")[0];
    assert.ok(logo, `${provider} renders an image mark`);
    const svg = decodeURIComponent(logo!.props.source.uri.split(",")[1]);
    assert.ok(svg.includes(`fill="${dark.foreground}"`), `${provider} uses the theme text colour`);
    assert.ok(!svg.includes("foreignObject"), `${provider} SVG is renderer-safe`);
  }
});

test("the plugin shell renders the page from the board navigation", async () => {
  await load();
  const snapshot = {
    revision: 1,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    occupiedSlots: 0,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [],
    queuedCounts: [],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [],
    prStates: {},
  };
  const serviceState = {
    state: "running",
    detail: "",
    error: "",
    ready: true,
    paused: false,
    hostId: "host",
  };
  const at = AT;
  const invoke = async (method: string, input: unknown) => {
    if (method === "usage.state") return fixture.state;
    if (method === "queue.ui-snapshot") return snapshot;
    if (method === "queue.service-state") return serviceState;
    if (method === "queue.detail") return undefined;
    if (method === "task.next") return null;
    if (method === "queue.queued-page") return { tasks: [], hasMore: false };
    if (method === "project.qa.list" || method === "host.run.list") return [];
    if (method === "host.run.board")
      return {
        runs: [],
        accounting: { readAt: at, entries: [], complete: true },
      };
    if (method === "lead.board") return { cards: [], links: [] };
    if (method === "decision.list") return [];
    if (
      method === "plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "project.owner-candidates"
    )
      return [];
    void input;
    return {};
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h((await import("../client/queue")).MainSurface as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  await settle(() => tree.text().includes("Tasks ("));
  tree.press("Usage");
  await settle(() => tree.text().includes("Codex · codex-main"));
  assert.ok(
    tree.text().includes("Will run out"),
    "the board navigation reaches the Usage page in the plugin shell",
  );
});
