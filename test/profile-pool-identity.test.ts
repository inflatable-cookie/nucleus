import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeSettings,
  type SettingsContext,
} from "../core/runtime/settings";
import { ProfileCatalogs } from "../core/host/profile-catalogs";
import type { Adapter } from "../core/host/adapter";
import { Store } from "../core/store/store";
import { configurePool, configureProfile } from "../shared/rpc/settings";
import type { PoolEntry, Profile } from "../shared/contracts";
import type { NucleusProfile } from "../shared/profiles";
import { hostCatalogSchema } from "../shared/host";

// Nucleus#1492: a pool save validates profile identity against the stored Nucleus
// profile records, never the routing snapshot a live host catalog builds. With the
// primary catalog unread, the routing list is empty; the stored records still stand.

const sol: NucleusProfile = {
  id: "sol-heavyweight",
  name: "Sol Heavyweight",
  provider: "codex",
  model: "gpt-5",
  notes: "",
};
const oracle: NucleusProfile = {
  id: "oracle",
  name: "Oracle",
  provider: "claude",
  model: "claude-opus-5-5",
  notes: "",
};

/** A stored pool row as the store keeps it: the canonical shape, one weight stop. */
const row = (profileId: string, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  profileId,
  enabled: true,
  group: "openai",
  roles: ["worker"],
  capability: "heavyweight",
  weight: "default",
  scopes: ["general"],
  ...extra,
});

/** A working secondary host (T3) that reports the stored Sol profile's provider and model. */
const t3Catalog = hostCatalogSchema.parse({
  providers: [
    {
      key: "codex",
      label: "Codex",
      available: true,
      problem: "",
      models: [
        {
          id: "gpt-5",
          label: "GPT-5",
          aliases: [],
          thinkingOptions: [],
          defaultThinkingOptionId: null,
          modes: [],
          features: [],
        },
      ],
    },
  ],
});

/**
 * One open store with its Settings and host state, as the service wires them. The
 * primary host is disconnected, so its routing snapshot is never built; the secondary
 * T3 host is read by a real catalog refresh. `catalogReads` counts every host read.
 */
async function open(path: string, catalogReads: { count: number }) {
  const store = new Store(path);
  const primary = {
    hostId: "paseo:primary",
    isConnected: () => false,
    catalog: async () => {
      throw new Error("primary host is disconnected");
    },
  } as unknown as Adapter;
  const secondary = {
    hostId: "t3code:env",
    isConnected: () => true,
    catalog: async () => {
      catalogReads.count++;
      return t3Catalog;
    },
  } as unknown as Adapter;
  const owner = {
    store,
    adapter: primary,
    primaryAdapter: primary,
    resolveHostAdapter: (id: string) =>
      id === "paseo:primary"
        ? primary
        : id === "t3code:env"
          ? secondary
          : undefined,
    hostIds: () => ["paseo:primary", "t3code:env"] as const,
    hostOnline: (id: string) => id === "t3code:env",
    profiles: [] as Profile[],
  };
  const catalogs = new ProfileCatalogs(owner);
  await catalogs.refresh();
  const context = {
    store,
    engine: {
      wake: async () => {},
      resumePausedStops: async () => {},
      rebuildProfiles: () => catalogs.rebuildProfiles(),
      profileCompatibility: () => catalogs.profileCompatibility(),
      secondaryCanonicalCatalogs: () => catalogs.secondaryCanonicalCatalogs(),
    },
    decisions: {} as never,
    capacityChanges: {} as never,
    started: Promise.resolve(),
    hostId: "paseo:primary",
    startError: "",
    adapter: primary,
    connected: () => false,
    wakeAndSettlePostBootstrapTimeout: async () => {},
    markStoreAccess: () => {},
  } as unknown as SettingsContext;
  return {
    store,
    routingSnapshot: owner.profiles,
    catalogs,
    settings: new RuntimeSettings(context),
    close: () => store.close(),
  };
}

async function withDir(run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "ns-profile-pool-identity-"),
  );
  try {
    await run(join(dir, "queue.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Sol's weight saves Default to More and back through the Settings path, survives reload, and a profile-definition write still succeeds", async () => {
  await withDir(async (path) => {
    const reads = { count: 0 };
    let session = await open(path, reads);
    try {
      session.store.setProfiles([sol]);
      session.store.setMeta("pool", [row(sol.id)]);
      session.close();
      session = await open(path, reads);
      // The precondition: the primary routing snapshot is empty while the secondary answers.
      assert.deepEqual(session.routingSnapshot, []);
      const works = session.catalogs
        .profileCompatibility()
        .rows.find((r) => r.profileId === sol.id && r.hostId === "t3code:env");
      assert.equal(
        works?.status,
        "works",
        `Sol runs on the working secondary host: ${works?.reason}`,
      );

      // Default -> More through the single-entry RPC path, read back, then reload.
      const beforeMore = reads.count;
      const more = configureProfile.input.parse({
        ...session.store.pool()[0],
        weight: "more",
      });
      assert.deepEqual(session.settings.configureProfile(more), { ok: true });
      assert.equal(session.store.pool()[0]?.weight, "more");
      assert.equal(
        reads.count,
        beforeMore,
        "a stored profile's save reads no host",
      );
      session.close();
      session = await open(path, reads);
      assert.equal(
        session.store.pool()[0]?.weight,
        "more",
        "More survives reload",
      );

      // More -> Default.
      const beforeBack = reads.count;
      const back = configureProfile.input.parse({
        ...session.store.pool()[0],
        weight: "default",
      });
      assert.deepEqual(session.settings.configureProfile(back), { ok: true });
      assert.equal(reads.count, beforeBack, "the return save reads no host");
      session.close();
      session = await open(path, reads);
      assert.equal(
        session.store.pool()[0]?.weight,
        "default",
        "Default survives reload",
      );

      // A profile-definition write in the same state is a separate path and succeeds.
      session.settings.profileUpdate({ id: sol.id, notes: "tuned" });
      session.close();
      session = await open(path, reads);
      assert.equal(
        session.store.profiles()[0]?.notes,
        "tuned",
        "the definition write survives reload",
      );
      assert.equal(
        session.store.pool()[0]?.weight,
        "default",
        "and it leaves the pool entry as it was",
      );
    } finally {
      session.close();
    }
  });
});

test("other single-entry fields save through the same owner while the routing snapshot is empty", async () => {
  await withDir(async (path) => {
    const session = await open(path, { count: 0 });
    try {
      session.store.setProfiles([sol]);
      session.store.setMeta("pool", [row(sol.id)]);
      session.settings.configureProfile(
        configureProfile.input.parse({
          ...session.store.pool()[0],
          group: "other-subscription",
        }),
      );
      assert.equal(session.store.pool()[0]?.group, "other-subscription");
      session.settings.configureProfile(
        configureProfile.input.parse({
          ...session.store.pool()[0],
          enabled: false,
        }),
      );
      assert.equal(session.store.pool()[0]?.enabled, false);
      session.settings.configureProfile(
        configureProfile.input.parse({
          ...session.store.pool()[0],
          capability: "worker",
        }),
      );
      assert.equal(session.store.pool()[0]?.capability, "worker");
    } finally {
      session.close();
    }
  });
});

test("a whole-pool save keeps an unrelated retained row and saves the changed Sol weight", async () => {
  await withDir(async (path) => {
    const session = await open(path, { count: 0 });
    try {
      session.store.setProfiles([sol, oracle]);
      // A retained row for a profile the operator removed from Nucleus is unchanged, so it stays.
      const retired = row("retired-profile", {
        enabled: false,
        group: "opencode-go",
      });
      session.store.setMeta("pool", [
        row(sol.id),
        row(oracle.id, { capability: "worker" }),
        retired,
      ]);
      const entries = session.store
        .pool()
        .map((entry) =>
          entry.profileId === sol.id
            ? { ...entry, weight: "more" as const }
            : entry,
        );
      session.settings.configurePool(configurePool.input.parse({ entries }));
      const after = session.store.pool();
      assert.equal(
        after.find((entry) => entry.profileId === sol.id)?.weight,
        "more",
      );
      assert.equal(
        after.find((entry) => entry.profileId === oracle.id)?.capability,
        "worker",
      );
      assert.deepEqual(
        after.find((entry) => entry.profileId === "retired-profile"),
        retired,
      );
    } finally {
      session.close();
    }
  });
});

test("a new or changed orphan entry is refused with wording that names the missing profile, not a catalog refresh", async () => {
  await withDir(async (path) => {
    const session = await open(path, { count: 0 });
    try {
      session.store.setProfiles([sol]);
      session.store.setMeta("pool", [row(sol.id)]);
      const before = session.store.pool();
      assert.throws(
        () =>
          session.settings.configureProfile(
            configureProfile.input.parse(row("ghost-profile")),
          ),
        (error: Error) =>
          /^Unknown profile ghost-profile\b/.test(error.message) &&
          !/refresh the catalog/.test(error.message),
      );
      assert.throws(
        () =>
          session.settings.configurePool(
            configurePool.input.parse({
              entries: [...before, row("ghost-profile")],
            }),
          ),
        /Unknown profile ghost-profile/,
      );
      assert.deepEqual(
        session.store.pool(),
        before,
        "a refused save leaves the stored pool as it was",
      );
    } finally {
      session.close();
    }
  });
});

test("duplicate and reserved-group validation still refuse a whole-pool save", async () => {
  await withDir(async (path) => {
    const session = await open(path, { count: 0 });
    try {
      session.store.setProfiles([sol]);
      session.store.setMeta("pool", [row(sol.id)]);
      assert.throws(
        () =>
          session.settings.configurePool({
            entries: [row(sol.id), row(sol.id)],
          }),
        /Duplicate pool profile/,
      );
      assert.throws(
        () =>
          session.settings.configureProfile(
            configureProfile.input.parse(row(sol.id, { group: "profile:x" })),
          ),
        /reserved/,
      );
    } finally {
      session.close();
    }
  });
});
