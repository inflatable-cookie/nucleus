import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { nucleusProfileSchema, type NucleusProfile } from "../shared/profiles";
import {
  poolSchema,
  profileCapabilityLevels,
  type PoolEntry,
  type UiQueueState,
} from "../shared/contracts";

/**
 * nucleus#1398: the Profiles list in Settings displays profiles in
 * capability-bracket order (`profileCapabilityLevels`: Mechanical, Worker,
 * Heavyweight, Frontier), preserving relative order within each bracket and
 * placing profiles with no or an unknown bracket last, without mutating stored
 * profile order.
 */

useNativeStubs();

const h = React.createElement;
const colors = new Proxy({}, { get: () => "#000" }) as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail("the profiles panel did not settle");
}

function storedProfile(
  id: string,
  name: string,
  provider = "codex",
  model = "gpt-5",
): NucleusProfile {
  return nucleusProfileSchema.parse({
    id,
    name,
    provider,
    model,
    modeId: "auto",
    thinkingOptionId: "high",
    notes: "",
  });
}

function storedPoolEntry(
  profileId: string,
  capability?: PoolEntry["capability"],
): PoolEntry {
  return poolSchema.parse({
    profileId,
    enabled: true,
    group: "codex",
    ...(capability !== undefined ? { capability } : {}),
    weight: "default",
  });
}

function uiState(pool: PoolEntry[]): UiQueueState {
  return {
    revision: 1,
    connected: true,
    canEditSettings: true,
    hostId: "host",
    paused: false,
    error: "",
    quiet: true,
    activeWorkers: 0,
    unsettled: 0,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [],
    profiles: [],
    pool,
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [],
    projectLimitOverrides: {},
    projectInFlightLimitOverrides: {},
    projectCapacities: [],
    prStates: {},
  } as unknown as UiQueueState;
}

test("Settings Profiles displays real stored profiles in capability-bracket order and puts unset or unknown brackets last", async () => {
  const { ProfilesPanel } = await import("../client/settings-profiles");

  const stored: NucleusProfile[] = [
    storedProfile("p-unrated-no-entry", "Unrated Missing Entry"),
    storedProfile("p-frontier-a", "Frontier Alpha"),
    storedProfile("p-worker-a", "Worker Alpha"),
    storedProfile("p-heavy-a", "Heavyweight Alpha"),
    storedProfile("p-unknown", "Unknown Bracket"),
    storedProfile("p-mech-a", "Mechanical Alpha"),
    storedProfile("p-worker-b", "Worker Beta"),
    storedProfile("p-unrated-null", "Unrated Null"),
    storedProfile("p-mech-b", "Mechanical Beta"),
    storedProfile("p-frontier-b", "Frontier Beta"),
    storedProfile("p-heavy-b", "Heavyweight Beta"),
  ];
  const storedOrderBefore = stored.map((profile) => profile.id);

  const pool: PoolEntry[] = [
    storedPoolEntry("p-frontier-a", "frontier"),
    storedPoolEntry("p-worker-a", "worker"),
    storedPoolEntry("p-heavy-a", "heavyweight"),
    // Simulate a corrupt/unknown bracket value arriving at runtime.
    {
      ...storedPoolEntry("p-unknown"),
      capability: "experimental" as unknown as PoolEntry["capability"],
    },
    storedPoolEntry("p-mech-a", "mechanical"),
    storedPoolEntry("p-worker-b", "worker"),
    storedPoolEntry("p-unrated-null", null),
    storedPoolEntry("p-mech-b", "mechanical"),
    storedPoolEntry("p-frontier-b", "frontier"),
    storedPoolEntry("p-heavy-b", "heavyweight"),
  ];
  const poolOrderBefore = pool.map((entry) => entry.profileId);

  assert.deepEqual(
    [...profileCapabilityLevels],
    ["mechanical", "worker", "heavyweight", "frontier"],
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invoke = async (method: string) => {
    if (method === "profile.list") return { profiles: stored };
    if (method === "profile.compatibility") return { hosts: [], rows: [] };
    if (method === "profile.vocabulary")
      return { readAt: "2026-11-19T00:00:00.000Z", providers: [] };
    return {};
  };

  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invoke as never,
        children: h(ProfilesPanel as never, {
          c: colors,
          compact: false,
          inset: 0,
          state: uiState(pool),
          repositories: [],
          busy: false,
          savePool: async () => {},
          savePoolList: async () => true,
          saveAvailability: async () => {},
        }),
      }),
    }),
  );

  await settle(() => ui.all(/^Edit /).length === stored.length);

  const renderedNames = ui
    .all(/^Edit /)
    .map((node) => String(node.props.accessibilityLabel).replace(/^Edit /, ""));

  assert.deepEqual(renderedNames, [
    "Mechanical Alpha",
    "Mechanical Beta",
    "Worker Alpha",
    "Worker Beta",
    "Heavyweight Alpha",
    "Heavyweight Beta",
    "Frontier Alpha",
    "Frontier Beta",
    "Unrated Missing Entry",
    "Unknown Bracket",
    "Unrated Null",
  ]);

  // Stored profile and pool arrays must remain untouched.
  assert.deepEqual(
    stored.map((profile) => profile.id),
    storedOrderBefore,
  );
  assert.deepEqual(
    pool.map((entry) => entry.profileId),
    poolOrderBefore,
  );
});
