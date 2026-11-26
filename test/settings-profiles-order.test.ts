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

