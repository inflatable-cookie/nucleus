import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { projectUsage } from "../shared/usage-projection";
import type { UsageProjectionWindow } from "../shared/usage-projection";
import {
  usageStateOutputSchema,
  type UsageStateOutput,
  type UsageSubscription,
} from "../shared/schema/usage";

// Spec 059 step 2 (nucleus#1113, #1123): the Usage page's pressure dial maps state and
// value correctly; the page renders subscriptions from a `usage.state` fixture; the
// Paseo sidebar row carries the board button and the rings, opens the board on its
// Usage tab and takes the host's active state; a host without the newer APIs keeps
// the native sidebar item; provider marks tint in native and web shells. The
// plugin shell renders the page from the board's navigation. Synthetic fixtures only.
// The web shell is exercised by test/web-shell.test.ts against the built bundle.
useNativeStubs();
type UsageModule = typeof import("../client/usage");
let usage: UsageModule;
let sidebar: typeof import("../hosts/paseo/client/sidebar");
let queue: typeof import("../client/queue");
const load = async () => {
  usage = await import("../client/usage");
  sidebar = await import("../hosts/paseo/client/sidebar");
  queue = await import("../client/queue");
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

test("sidebar rings count down: full when unused, the remaining share when partly used, empty and muted when unknown", async () => {
  await load();
  const host = await import("../hosts/paseo/client/usage");
  // The ring's arcs are its only Views with a coloured border edge; each carries its sweep as a rotation.
  const arcs = (tree: ReturnType<typeof mount>) =>
    tree
      .ofType("View")
      .filter((node) => node.props.style?.transform && node.props.style.borderWidth)
      .map((node) => ({
        rotate: node.props.style.transform[0].rotate as string,
        color: (node.props.style.borderTopColor === "transparent" ? node.props.style.borderBottomColor : node.props.style.borderTopColor) as string,
      }));
  const ring = (subscription: UsageSubscription) =>
    mount(h(host.UsageRailRing, { c, subscription, onPress: () => {} }));
  const label = (tree: ReturnType<typeof mount>) =>
    tree.get(/usage: /).props.accessibilityLabel as string;

  const unused = subscription({
    provider: "claude",
    reading: reading([window({ usedFraction: 0 })], "cache"),
    projection: projectUsage({ now: NOW, windows: [window({ usedFraction: 0 })] }),
  })!;
  const full = ring(unused);
  assert.deepEqual(arcs(full).map((arc) => arc.rotate), ["45deg", "45deg"], "an unused window fills the whole ring");
  assert.match(label(full), /, 100% left\. Opens the usage page$/);

  const partly = ring(fixture.subscriptions[0]!);
  // 62% used leaves 38%: the right half sweeps 0.38 of a turn from 12 o'clock, the left half stays unmounted.
  assert.deepEqual(arcs(partly).map((arc) => arc.rotate), [`${360 * (1 - 0.62) - 135}deg`]);
  assert.equal(arcs(partly)[0]!.color, dark.statusDanger);
  assert.match(label(partly), /^Codex usage: Will run out.*, 38% left\. Opens the usage page$/);

  const unknown = ring(fixture.subscriptions[3]!);
  assert.deepEqual(arcs(unknown).map((arc) => arc.rotate), ["-135deg"], "an unknown reading paints no arc");
  assert.equal(arcs(unknown)[0]!.color, dark.foregroundMuted, "an unknown ring stays muted");
  assert.ok(!label(unknown).includes("left"), "an unknown ring claims nothing about what's left");

  const expired = ring({ ...fixture.subscriptions[0]!, stale: { expired: true, ageMs: 9 * HOUR, failedAt: AT, reason: "read failed" } });
  assert.deepEqual(arcs(expired).map((arc) => arc.rotate), ["-135deg"], "an expired reading empties the ring");
  assert.equal(arcs(expired)[0]!.color, dark.foregroundMuted);
});

test("friendly labels and reset verdicts read as the brief writes them", async () => {
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
  assert.equal(usage.friendlyWindowName(window()), "This week");
  assert.equal(usage.friendlyWindowName(window({ windowSeconds: 5 * 3600, name: "5-hour" })), "Next 5 hours");
  assert.equal(usage.friendlyWindowName(window({ name: "Credits" })), "Billing period");
  assert.equal(usage.resetDay(new Date(RESET).toISOString()), "Saturday");
  assert.match(usage.usageVerdict(fixture.subscriptions[2]!, NOW), /^On track\. You should reach Saturday's reset with about \d+% to spare\.$/);
  assert.match(usage.usageVerdict(fixture.subscriptions[1]!, NOW), /^Plenty of room\. On track to use about \d+% by Saturday's reset\.$/);
  assert.match(usage.usageVerdict(fixture.subscriptions[0]!, NOW), /^At this pace you'll run out Friday (morning|afternoon|evening|tonight), about 1 day before Saturday's reset\.$/);
  assert.equal(usage.usageVerdict(fixture.subscriptions[3]!, NOW), "Usage unavailable right now.");
});

test("the page renders verdicts and friendly usage window rows", async () => {
  await load();
  const tree = mountPage(fixture.state);
  await settle(() => tree.text().includes("Codex"));
  const text = tree.text();

  const pageLogos = tree.ofType("Image").map((node) => node.props.accessibilityLabel);
  for (const provider of ["Claude", "Codex", "Grok"]) {
    assert.ok(pageLogos.includes(`${provider} logo`), `${provider} logo renders on the page`);
  }
  assert.ok(text.includes("At this pace you'll run out Friday"));
  assert.ok(text.includes("Plenty of room. On track to use about"));
  assert.ok(text.includes("On track. You should reach Saturday's reset"));
  assert.ok(text.includes("Usage unavailable right now."));
  assert.ok(text.includes("This week"), "weekly windows use a friendly name");
  assert.ok(text.includes("Resets Saturday 12:00"), "reset row carries day and local time");
  assert.ok(text.includes("62% used"));
  assert.ok(text.includes("62% used · pace 109%"), "the binding window shows projected pace");
  assert.ok(tree.query("Usage help"), "the page-level help remains");
  assert.equal(tree.query("Codex help"), undefined, "provider cards have no help button");
  assert.ok(!text.includes("codex-main"), "the subscription group stays hidden");
  assert.ok(!text.includes("binding window"), "internal binding label stays hidden");
  assert.ok(!text.includes("app-server"), "reader source stays out of visible text");
  assert.ok(!text.includes("next read"), "next read stays in the help popover");
  assert.ok(!text.includes("updated"), "fresh readings do not show an age note");
  assert.ok(!text.includes("0% used · reset time unknown · "), "a broken subscription never reads as an empty window");
  const marker = tree.ofType("View").find((node) => node.props.testID === "usage-pace-marker");
  assert.equal(marker?.props.style.left, `${(4 / 7) * 100}%`, "the marker tracks elapsed window time");
});

test("the binding row omits pace when its projection is unknown", async () => {
  await load();
  const subscriptions = fixture.state.subscriptions.map((subscription) => ({
    ...subscription,
    projection: {
      ...subscription.projection,
      windows: subscription.projection.windows.map((entry) => ({ ...entry, pace: null })),
    },
  }));
  const tree = mountPage({ ...fixture.state, subscriptions });
  await settle(() => tree.text().includes("Codex"));
  assert.ok(tree.text().includes("62% used"));
  assert.ok(!/· pace \d/.test(tree.text()), "unknown pace is not rendered");
});

test("stale readings remain visible with a quiet warning and expired readings lose the dial", async () => {
  await load();
  const subscriptions = [...fixture.state.subscriptions];
  subscriptions[0] = {
    ...subscriptions[0]!,
    stale: { reason: "timed out", failedAt: AT, ageMs: 40 * 60_000, expired: false },
  };
  const staleTree = mountPage({ ...fixture.state, subscriptions });
  await settle(() => staleTree.text().includes("Showing the reading from"));
  assert.ok(staleTree.text().includes("Showing the reading from 40m ago: couldn't refresh (timed out)"));
  assert.ok(staleTree.text().includes("At this pace you'll run out Friday"));
  staleTree.update(h(React.Fragment, {}));

  subscriptions[0] = {
    ...subscriptions[0]!,
    stale: { reason: "timed out", failedAt: AT, ageMs: 2 * HOUR, expired: true },
    projection: { ...subscriptions[0]!.projection, state: "unknown", dial: null },
  };
  const expiredTree = mountPage({ ...fixture.state, subscriptions });
  await settle(() => expiredTree.text().includes("Usage unavailable right now."));
  assert.ok(expiredTree.text().includes("62% used"));
  assert.ok(expiredTree.text().includes("This week · expired"));
});

test("the sidebar row carries the board button and the rings on one line", async () => {
  await load();
  const opened: string[] = [];
  // The fake client mirrors the plugin's rpc: the caller hands the contract, the
  // invoke receives its name.
  const invoke = invokeWith(fixture.state);
  const client = {
    rpc: (contract: { name: string }, input: unknown) =>
      invoke(contract.name, input),
  } as never;
  const Row = sidebar.createNucleusSidebarRow(client);
  const tree = mount(
    h(Row, {
      theme: { colors: c },
      layout: { compact: false },
      currentScreen: null,
      openScreen: (input: { screenId: string }) => {
        opened.push(input.screenId);
      },
    }),
  );
  await settle(
    () => tree.all(/usage: /).length === fixture.subscriptions.length,
  );

  // One row: the Nucleus button (icon and title) on the left, the rings trailing
  // on the right; the button takes the free width, so the rings sit at the end.
  const rowNode = tree.get("Nucleus sidebar row");
  assert.equal(rowNode.props.style.flexDirection, "row");
  assert.equal(
    rowNode.props.style.width,
    "100%",
    "the row spans the sidebar, so its trailing rings meet the right edge",
  );
  assert.equal(
    rowNode.props.style.backgroundColor,
    "transparent",
    "an idle row carries no highlight",
  );
  const button = tree.get("Nucleus");
  assert.equal(button.props.accessibilityState.selected, false);
  assert.equal(button.props.style.flex, 1, "the button takes the row's left side");
  const icon = button.children.find(
    (child) => typeof child !== "string",
  ) as HostNode;
  assert.equal(icon.type, "Icon");
  assert.equal(icon.props.name, "ListTodo");
  assert.equal(
    icon.props.color,
    dark.foregroundMuted,
    "an idle row's icon takes the muted theme colour",
  );
  assert.ok(tree.text().includes("Nucleus"), "the row names the board button");

  // Hover lights the whole row, from the theme's raised surface.
  rowNode.props.onPointerEnter();
  assert.equal(tree.get("Nucleus sidebar row").props.style.backgroundColor, dark.surface2);
  tree.get("Nucleus sidebar row").props.onPointerLeave();
  assert.equal(tree.get("Nucleus sidebar row").props.style.backgroundColor, "transparent");

  // The button opens the board; the rings open the board on its Usage tab.
  tree.get("Nucleus").props.onPress();
  assert.deepEqual(opened, [sidebar.BOARD_SCREEN_ID], "the button opens the board");

  const ringLogos = tree.ofType("Image").map((node) => node.props.accessibilityLabel);
  for (const provider of ["Claude", "Codex", "Grok"]) {
    assert.ok(ringLogos.includes(`${provider} logo`), `${provider} logo renders in the row`);
  }
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
  const railMarks = tree.ofType("Image");
  assert.ok(
    railMarks.every(
      (image) =>
        image.props.source.uri.startsWith("data:image/png;base64,") &&
        image.props.style.width > 0 &&
        image.props.style.height > 0 &&
        image.props.style.tintColor === dark.foreground,
    ),
    "row marks have painted pixel sources, visible dimensions, and the theme tint regardless of reading state",
  );
  tree.query(/^Codex usage: /)!.props.onPress();
  assert.deepEqual(
    opened,
    [sidebar.BOARD_SCREEN_ID, sidebar.BOARD_SCREEN_ID],
    "a ring opens the board surface, not a separate usage screen",
  );

  // The press asked the board for its Usage tab: a board that mounts next lands there.
  const board = mountBoard();
  await settle(() => board.text().includes("Codex"));
  assert.ok(
    board.text().includes("At this pace you'll run out"),
    "the ring's request lands on the board's Usage tab",
  );
  board.update(h(React.Fragment, {}));
});

test("the row shows the board's active state and a ring moves an open board", async () => {
  await load();
  const opened: string[] = [];
  const invoke = invokeWith(fixture.state);
  const client = {
    rpc: (contract: { name: string }, input: unknown) =>
      invoke(contract.name, input),
  } as never;
  const Row = sidebar.createNucleusSidebarRow(client);
  const tree = mount(
    h(Row, {
      theme: { colors: c },
      layout: { compact: false },
      currentScreen: { screenId: sidebar.BOARD_SCREEN_ID },
      openScreen: (input: { screenId: string }) => {
        opened.push(input.screenId);
      },
    }),
  );
  await settle(
    () => tree.all(/usage: /).length === fixture.subscriptions.length,
  );
  const button = tree.get("Nucleus");
  assert.equal(
    button.props.accessibilityState.selected,
    true,
    "the board's own screen marks the row active",
  );
  assert.equal(
    tree.get("Nucleus sidebar row").props.style.backgroundColor,
    dark.surface2,
    "the active row carries Paseo's highlight",
  );
  const icon = button.children.find(
    (child) => typeof child !== "string",
  ) as HostNode;
  assert.equal(icon.props.color, dark.foreground, "an active row's icon takes the text colour");

  // An open board moves to the tab a ring asks for, without waiting for a remount.
  const board = mountBoard();
  await settle(() => board.text().includes("Tasks ("));
  tree.query(/^Claude usage: /)!.props.onPress();
  assert.deepEqual(opened, [sidebar.BOARD_SCREEN_ID]);
  await settle(() => board.text().includes("Codex"));
  queue.requestBoardTab("queue");
  await settle(() => board.text().includes("Tasks ("));
  board.update(h(React.Fragment, {}));
});

/** Decode an 8-bit RGBA PNG's alpha channel: its width, height and the alpha byte per pixel. */
function pngAlpha(png: Buffer): { width: number; height: number; alpha: Uint8Array } {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "a PNG signature");
  let offset = 8, width = 0, height = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, "8-bit channels");
      assert.equal(body[9], 6, "RGBA colour type");
      assert.equal(body[12], 0, "not interlaced");
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * 4;
  const pixels = new Uint8Array(stride * height), alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4]! : 0, up = y ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = x >= 4 && y ? pixels[(y - 1) * stride + x - 4]! : 0;
      const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
      const predictor = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft][filter]!;
      pixels[y * stride + x] = (row[x]! + predictor) & 0xff;
    }
  }
  for (let i = 0; i < width * height; i++) alpha[i] = pixels[i * 4 + 3]!;
  return { width, height, alpha };
}

test("provider marks are bundled PNGs that actually paint, cropped to the mark", async () => {
  await load();
  const assets = await import("../client/provider-logo-assets");
  for (const provider of ["claude", "codex", "grok"]) {
    const source = assets.providerLogoSource(provider);
    assert.ok(source?.startsWith("data:image/png;base64,"), `${provider} uses a PNG data URI`);
    const { width, height, alpha } = pngAlpha(Buffer.from(source!.slice("data:image/png;base64,".length), "base64"));
    assert.ok(width >= 48 && height >= 32, `${provider} is rasterised at 3x or more of the 16 px card size`);
    let painted = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (alpha[y * width + x]! > 128) {
          painted++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
    // A blank or fully transparent source paints nothing; a mark lost in its
    // viewBox padding (the Codex knot once filled half its box) paints small.
    assert.ok(painted / (width * height) > 0.15, `${provider} paints visible pixels (${painted} of ${width * height})`);
    assert.ok(maxX - minX + 1 >= width * 0.85 || maxY - minY + 1 >= height * 0.85, `${provider} fills its box`);
  }
  assert.equal(assets.providerLogoSource("unknown"), null);
});

test("cards put a large dial left of one content column, stacking when narrow", async () => {
  await load();
  const tree = mountPage(fixture.state);
  await settle(() => tree.text().includes("Codex"));
  const card = tree.ofType("View").find((node) => /^Codex usage: /.test(node.props.accessibilityLabel ?? ""))!;
  assert.equal(card.props.style.flexDirection, "row", "the dial sits left of the column");
  assert.equal(card.props.style.alignItems, "center", "the dial is vertically centred");
  const [dial, column] = card.children as HostNode[];
  assert.match(dial!.props.accessibilityLabel, /^Usage dial: /);
  assert.equal(dial!.props.style.width, usage.USAGE_CARD_DIAL_SIZE, "about twice the earlier 88 px dial");
  assert.equal(column!.props.testID, "usage-card-column");
  const columnText = JSON.stringify(column);
  for (const part of ["Codex logo", "Codex", "At this pace", "This week", "62% used"])
    assert.ok(columnText.includes(part), `${part} sits in the column right of the dial`);
  card.props.onLayout({ nativeEvent: { layout: { width: usage.USAGE_CARD_STACK_WIDTH - 1 } } });
  const narrow = tree.ofType("View").find((node) => /^Codex usage: /.test(node.props.accessibilityLabel ?? ""))!;
  assert.equal(narrow.props.style.flexDirection, "column", "a narrow card stacks the dial above the column");
  // The used bar takes the state colour; the on-pace marker stays neutral.
  const bars = tree.ofType("View").filter((node) => node.props.testID === "usage-used-bar");
  assert.equal(bars[0]!.props.style.backgroundColor, dark.statusDanger, "Codex runs out: red bar");
  assert.equal(bars[1]!.props.style.backgroundColor, dark.statusSuccess, "Claude has spare: green bar");
  const marker = tree.ofType("View").find((node) => node.props.testID === "usage-pace-marker");
  assert.equal(marker!.props.style.backgroundColor, dark.foreground);
});

test("plenty of room only well under 100%, and resets round to the minute", async () => {
  await load();
  const verdictAt = (usedFraction: number) => {
    const projection = projectUsage({ now: NOW, windows: [window({ usedFraction })] });
    return usage.usageVerdict(
      subscription({ reading: reading([window({ usedFraction })]), projection }) as never,
      NOW,
    );
  };
  // 4/7 of the week elapsed: 0.53 used projects 93% at reset, 0.4 projects 70%.
  assert.equal(verdictAt(0.53), "On track. You should reach Saturday's reset with about 7% to spare.");
  assert.match(verdictAt(0.4), /^Plenty of room\. On track to use about 70% by Saturday's reset\.$/);
  const local = (h: number, m: number, sec: number) => new Date(2026, 10, 14, h, m, sec).toISOString();
  assert.equal(usage.resetLabel(local(8, 59, 59)), "Resets Saturday 09:00");
  assert.equal(usage.resetLabel(local(8, 59, 20)), "Resets Saturday 08:59");
  assert.equal(usage.resetDay(local(23, 59, 45)), "Sunday", "the rounded minute names the day");
  assert.equal(usage.resetLabel(null), "Reset time unavailable");
});

test("a passed reset shows zero used and the last known reset time", async () => {
  await load();
  const pastReset = new Date(NOW - HOUR).toISOString();
  const resetWindow = window({
    windowId: "seven_day",
    name: "Weekly",
    usedFraction: 0.89,
    resetsAt: pastReset,
  });
  const projection = projectUsage({ now: NOW, windows: [resetWindow] });
  const sub = subscription({
    provider: "claude",
    reading: reading([resetWindow], "cache"),
    projection,
  });
  assert.match(usage.usageVerdict(sub as never, NOW), /Next reset unknown/);
  const tree = mountPage({
    ...fixture.state,
    subscriptions: [sub],
  });
  await settle(() => tree.text().includes("not sampled since"));
  assert.ok(tree.text().includes("Reset at"));
  assert.ok(tree.text().includes("0% used"));
  assert.ok(!tree.text().includes("89% used"));

  const inactive = window({
    windowId: "five_hour",
    name: "5-hour",
    usedFraction: 0,
    windowSeconds: 5 * 3600,
    resetsAt: null,
    notStarted: true,
  });
  const inactiveSub = subscription({
    provider: "claude",
    reading: reading([inactive], "cache"),
    projection: projectUsage({ now: NOW, windows: [inactive] }),
  });
  const inactiveTree = mountPage({
    ...fixture.state,
    subscriptions: [inactiveSub],
  });
  await settle(() => inactiveTree.text().includes("Not started"));
  assert.ok(inactiveTree.text().includes("0% used"));
  assert.ok(inactiveTree.text().includes("The 5-hour window has not started."));
});

test("the entry registers the combined row only where the host carries it", async () => {
  await load();
  const contribute = (await import("../hosts/paseo/client/index")).default;
  const fake = (newer: boolean) => {
    const calls = {
      sidebarItems: 0,
      surfaces: [] as string[],
      screens: [] as string[],
      rows: [] as string[],
    };
    const remove = () => {};
    const host: Record<string, unknown> = {
      // The decision pills read the board snapshot and the open decisions; the board
      // fixtures the shell test uses are not needed here.
      rpc: async (contract: { name: string }) =>
        contract.name === "decision.list"
          ? []
          : contract.name === "queue.ui-snapshot"
            ? { revision: 1 }
            : {},
      paseo: {
        agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
      },
      addSurface: (id: string) => {
        calls.surfaces.push(id);
        return remove;
      },
      addSidebarItem: () => {
        calls.sidebarItems += 1;
        return remove;
      },
      addSettingsScreen: () => remove,
      addWorkspacePanel: () => remove,
      addCommandCenterItem: () => remove,
      addComposerPill: () => ({ update: () => {}, remove }),
      openPanel: () => {},
      openSettings: () => {},
    };
    if (newer) {
      host.addScreen = (contribution: { id: string }) => {
        calls.screens.push(contribution.id);
        return remove;
      };
      host.addSidebarHeaderItem = (contribution: { id: string }) => {
        calls.rows.push(contribution.id);
        return remove;
      };
    }
    return { calls, host };
  };

  const older = fake(false);
  const removeOlder = contribute(older.host as never);
  try {
    assert.equal(older.calls.sidebarItems, 1, "a host without the newer APIs keeps the native sidebar item");
    assert.deepEqual(older.calls.surfaces, ["main"], "and the plugin's own board surface");
    assert.deepEqual(older.calls.screens, [], "and registers no plugin screen");
    assert.deepEqual(older.calls.rows, [], "and no custom row");
  } finally {
    removeOlder();
  }

  const newer = fake(true);
  const removeNewer = contribute(newer.host as never);
  try {
    assert.equal(newer.calls.sidebarItems, 0, "a newer host registers no duplicate native item");
    assert.deepEqual(newer.calls.surfaces, [], "the untitled legacy surface is not registered as well");
    assert.deepEqual(newer.calls.screens, [sidebar.BOARD_SCREEN_ID], "the board registers as a titled screen");
    assert.deepEqual(newer.calls.rows, [sidebar.BOARD_ROW_ID], "one Nucleus row carries button and rings");
  } finally {
    removeNewer();
  }
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
    assert.ok(logo!.props.style.width > 0 && logo!.props.style.height > 0, `${provider} has a visible image size`);
    assert.equal(logo!.props.style.tintColor, dark.foreground, `${provider} takes the theme text colour`);
    assert.ok(logo!.props.source.uri.includes("data:image/png;base64,"), `${provider} has a painted image source`);
  }
});

/**
 * The board mounted under the plugin shell's providers against a quiet fixture:
 * empty snapshot, no QA runs, no records. Returns the mounted tree; callers cast
 * it away with `update(h(React.Fragment, {}))` when no longer needed.
 */
function mountBoard() {
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
        accounting: { readAt: AT, entries: [], complete: true },
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
  return mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
}

test("the plugin shell renders the page from the board navigation", async () => {
  await load();
  const tree = mountBoard();
  await settle(() => tree.text().includes("Tasks ("));
  tree.press("Usage");
  await settle(() => tree.text().includes("Codex"));
  assert.ok(
    tree.text().includes("At this pace you'll run out"),
    "the board navigation reaches the Usage page in the plugin shell",
  );
  tree.update(h(React.Fragment, {}));
});
