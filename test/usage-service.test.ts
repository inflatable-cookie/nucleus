import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import {
  UsageService,
  providerUsageKind,
  codexHome,
  claudeConfigDir,
  grokHome,
  USAGE_READ_INTERVAL_MS,
  USAGE_BACKOFF_BASE_MS,
  USAGE_BACKOFF_MAX_MS,
  USAGE_SAMPLE_RETENTION_MS,
} from "../core/usage/usage-service";
import type { ProviderUsageReader } from "../core/usage/readers";
import {
  usageReadingSchema,
  usageStateOutputSchema,
  type UsageReading,
  type UsageWindow,
} from "../shared/schema/usage";
import type { NucleusProfile } from "../shared/profiles";
import type { PoolEntry } from "../shared/schema/settings";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "usage-service-"));
  const store = new Store(join(dir, "queue.sqlite"));
  return { dir, store };
}

function profile(id: string, provider: string): NucleusProfile {
  return { id, name: id, provider, model: "", notes: "" };
}

function poolEntry(profileId: string, group: string): PoolEntry {
  return {
    profileId,
    enabled: true,
    group,
    roles: ["worker"],
    weight: 1,
    scopes: ["general"],
  };
}

function okReading(
  windows: Partial<UsageWindow>[] = [],
  asOf = "2026-11-11T12:00:00.000Z",
  accountId: string | null = null,
): UsageReading {
  return usageReadingSchema.parse({
    status: "ok",
    reason: null,
    asOf,
    accountId,
    source: "test",
    windows: windows.map((window) => ({
      windowId: "weekly",
      name: "Weekly",
      usedFraction: 0.5,
      windowSeconds: 7 * 24 * 60 * 60,
      windowStartsAt: null,
      resetsAt: new Date(
        Date.parse(asOf) + 3 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      ...window,
    })),
  });
}

function reader(result: UsageReading): ProviderUsageReader {
  return { provider: "codex", read: async () => result };
}

test("a provider key maps to its reading kind, or to nothing", () => {
  assert.equal(providerUsageKind("openai-codex"), "codex");
  assert.equal(providerUsageKind("Codex"), "codex");
  assert.equal(providerUsageKind("claude"), "claude");
  assert.equal(providerUsageKind("claude-code"), "claude");
  assert.equal(providerUsageKind("grok"), "grok");
  assert.equal(providerUsageKind("xai-grok-bot"), "grok");
  assert.equal(providerUsageKind("glm"), null);
  assert.equal(providerUsageKind("openai"), null);
});

test("the default sources resolve from the environment, never a fixed path", () => {
  assert.equal(
    codexHome({ CODEX_HOME: "/srv/example/codex-home" }),
    "/srv/example/codex-home",
  );
  assert.equal(codexHome({}), codexHome());
  assert.equal(
    claudeConfigDir({ CLAUDE_CONFIG_DIR: "/srv/example/claude-config" }),
    "/srv/example/claude-config",
  );
  assert.equal(claudeConfigDir({}), claudeConfigDir());
  assert.equal(grokHome({ GROK_HOME: "/srv/example/grok-home" }), "/srv/example/grok-home");
  assert.equal(grokHome({}), null);
});

test("subscription groups map to readers per provider and never merge accounts or groups", () => {
  const { store } = fixture();
  try {
    store.setProfiles([
      profile("p1", "openai-codex"),
      profile("p2", "claude"),
      profile("p3", "codex"),
      profile("p4", "glm"),
      profile("p5", "grok"),
    ]);
    store.setMeta("pool", [
      poolEntry("p1", "codex-pro"),
      poolEntry("p3", "codex-spare"),
      poolEntry("p2", "claude-max"),
      poolEntry("p4", "glm-group"),
      poolEntry("p5", "grok-pro"),
    ]);
    const service = new UsageService(store, {
      env: { CODEX_HOME: "/srv/example/codex", GROK_HOME: "/srv/example/grok" },
    });
    const targets = service.targets();
    assert.deepEqual(
      targets.map((target) => `${target.group}:${target.provider}`),
      ["claude-max:claude", "codex-pro:codex", "codex-spare:codex", "grok-pro:grok"],
    );
    assert.deepEqual(
      targets.find((target) => target.group === "codex-pro")!.profileIds,
      ["p1"],
    );
    assert.equal(
      targets.find((target) => target.group === "codex-pro")!.sourcePath,
      "/srv/example/codex",
    );
    assert.equal(
      targets.find((target) => target.group === "claude-max")!.sourcePath,
      claudeConfigDir({}),
    );
    assert.equal(
      targets.find((target) => target.group === "grok-pro")!.sourcePath,
      "/srv/example/grok",
    );
    assert.ok(
      !targets.some((target) => target.group === "glm-group"),
      "a provider with no reader gains no subscription",
    );
    const state = service.state();
    assert.equal(state.subscriptions.length, 4);
    for (const subscription of state.subscriptions) {
      assert.equal(subscription.reading.status, "unknown");
      assert.match(subscription.reading.reason!, /not sampled yet/);
      assert.equal(subscription.projection.state, "unknown");
    }
    assert.ok(usageStateOutputSchema.parse(state));
  } finally {
    store.close();
  }
});

test("one group naming two readable providers tracks each as its own subscription", () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex"), profile("p2", "grok")]);
    store.setMeta("pool", [
      poolEntry("p1", "shared-group"),
      poolEntry("p2", "shared-group"),
    ]);
    const service = new UsageService(store, { env: {} });
    const targets = service.targets();
    assert.deepEqual(
      targets.map((target) => `${target.group}:${target.provider}`),
      ["shared-group:codex", "shared-group:grok"],
    );
    assert.deepEqual(targets[0]!.profileIds, ["p1"]);
    assert.deepEqual(targets[1]!.profileIds, ["p2"]);
  } finally {
    store.close();
  }
});

test("a read stores its sample rows while state calculates the projection", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex")]);
    store.setMeta("pool", [poolEntry("p1", "codex-pro")]);
    const asOf = "2026-11-11T12:00:00.000Z";
    const service = new UsageService(store, {
      env: {},
      readers: {
        codex: reader(
          okReading(
            [
              { windowId: "weekly", name: "Weekly", usedFraction: 0.8 },
              {
                windowId: "5-hour",
                name: "5-hour",
                usedFraction: 0.9,
                windowSeconds: 5 * 60 * 60,
              },
            ],
            asOf,
            "00000000-0000-4000-8000-00000000000a",
          ),
        ),
      },
      now: () => new Date(Date.parse(asOf)),
    });
    await service.refresh({ dueOnly: false });
    const state = service.state();
    assert.equal(state.subscriptions.length, 1);
    const subscription = state.subscriptions[0]!;
    assert.equal(subscription.reading.status, "ok");
    assert.equal(
      subscription.reading.accountId,
      "00000000-0000-4000-8000-00000000000a",
    );
    assert.equal(subscription.projection.state, "will_run_out");
    assert.equal(subscription.projection.bindingWindowId, "weekly");
    assert.equal(
      subscription.nextReadAt,
      new Date(Date.parse(asOf) + USAGE_READ_INTERVAL_MS.codex).toISOString(),
    );
    assert.equal(subscription.lastAttemptAt, asOf);
    assert.equal(subscription.lastError, null);
    const samples = store.db
      .prepare(
        "SELECT window_id,used_fraction,account_id FROM usage_samples ORDER BY window_id",
      )
      .all();
    assert.equal(samples.length, 2);
    assert.equal(
      samples[0]!.account_id,
      "00000000-0000-4000-8000-00000000000a",
    );
    assert.equal(samples[1]!.window_id, "weekly");
  } finally {
    store.close();
  }
});

test("an identical cached read does not store a duplicate sample", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "claude")]);
    store.setMeta("pool", [poolEntry("p1", "claude-max")]);
    // The same cache instant twice: the second read rewrites state but adds no row.
    const cached = okReading(
      [
        {
          windowId: "seven_day",
          name: "Weekly",
          usedFraction: 0.57,
          windowSeconds: 7 * 24 * 60 * 60,
        },
      ],
      "2026-11-11T09:00:00.000Z",
      "00000000-0000-4000-8000-00000000000b",
    );
    let reads = 0;
    const service = new UsageService(store, {
      env: {},
      now: () => new Date(Date.parse("2026-11-11T12:00:00.000Z")),
      readers: {
        claude: {
          provider: "claude",
          read: async () => {
            reads++;
            return cached;
          },
        },
      },
    });
    await service.refresh({ dueOnly: false });
    await service.refresh({ dueOnly: false });
    assert.equal(reads, 2);
    const rows = store.db.prepare("SELECT id FROM usage_samples").all();
    assert.equal(rows.length, 1);
  } finally {
    store.close();
  }
});

test("readings with different accounts never merge samples or projections", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex")]);
    store.setMeta("pool", [poolEntry("p1", "codex-pro")]);
    const readings = [
      okReading(
        [{ usedFraction: 0.2 }],
        "2026-11-11T11:00:00.000Z",
        "00000000-0000-4000-8000-00000000000a",
      ),
      okReading(
        [{ usedFraction: 0.9 }],
        "2026-11-11T12:00:00.000Z",
        "00000000-0000-4000-8000-00000000000b",
      ),
    ];
    let index = 0;
    const service = new UsageService(store, {
      env: {},
      now: () =>
        new Date(
          Date.parse("2026-11-11T12:00:00.000Z") +
            index * USAGE_READ_INTERVAL_MS.codex,
        ),
      readers: {
        codex: {
          provider: "codex",
          read: async () => readings[Math.min(index++, readings.length - 1)]!,
        },
      },
    });
    await service.refresh({ dueOnly: false });
    await service.refresh({ dueOnly: false });
    const rows = store.db
      .prepare("SELECT account_id,used_fraction FROM usage_samples ORDER BY id")
      .all();
    assert.deepEqual(
      rows.map((row) => `${row.account_id}=${row.used_fraction}`),
      [
        "00000000-0000-4000-8000-00000000000a=0.2",
        "00000000-0000-4000-8000-00000000000b=0.9",
      ],
    );
    // The state carries the newest reading only: account b's 90%, projected red.
    const state = service.state();
    assert.equal(
      state.subscriptions[0]!.reading.accountId,
      "00000000-0000-4000-8000-00000000000b",
    );
    assert.equal(state.subscriptions[0]!.projection.state, "will_run_out");
  } finally {
    store.close();
  }
});

test("failed reads back off by doubling to the hour cap, and success resets the schedule", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "grok")]);
    store.setMeta("pool", [poolEntry("p1", "grok-1")]);
    const failing = usageReadingSchema.parse({
      status: "unknown",
      reason: "grok usage exited 1",
      asOf: "2026-11-11T12:00:00.000Z",
      source: "grok-cli",
      accountId: null,
      windows: [],
    });
    let attempts = 0;
    const service = new UsageService(store, {
      env: {},
      now: () => new Date(Date.parse("2026-11-11T12:00:00.000Z")),
      readers: {
        grok: {
          provider: "grok",
          read: async () => (attempts++ < 9 ? failing : okReading()),
        },
      },
    });
    // Doubling: 1, 2, 4, 8, 16, 32 minutes, then the 60-minute cap for attempt 7 on.
    const expectedGaps = [1, 2, 4, 8, 16, 32, 60, 60, 60].map(
      (minutes) => minutes * 60_000,
    );
    for (let attempt = 0; attempt < 9; attempt++) {
      await service.refresh({ dueOnly: false });
      const subscription = service.state().subscriptions[0]!;
      assert.equal(subscription.reading.status, "unknown");
      assert.match(subscription.lastError!, /exited 1/);
      assert.equal(subscription.stale, null, "a failed first read has no last good value");
      const gap =
        Date.parse(subscription.nextReadAt!) -
        Date.parse(subscription.lastAttemptAt!);
      assert.equal(
        gap,
        expectedGaps[attempt],
        `backoff attempt ${attempt + 1}`,
      );
    }
    // The tenth read succeeds: back to the steady cadence, no error, counters reset.
    await service.refresh({ dueOnly: false });
    const subscription = service.state().subscriptions[0]!;
    assert.equal(subscription.reading.status, "ok");
    assert.equal(subscription.lastError, null);
    const gap =
      Date.parse(subscription.nextReadAt!) -
      Date.parse(subscription.lastAttemptAt!);
    assert.equal(gap, USAGE_READ_INTERVAL_MS.grok);
  } finally {
    store.close();
  }
});

test("a failed refresh serves the last good reading and projects it until its windows expire", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "grok")]);
    store.setMeta("pool", [poolEntry("p1", "grok-1")]);
    const base = Date.parse("2026-11-11T12:00:00.000Z");
    let now = base;
    const good = okReading([{ usedFraction: 0.7 }], new Date(base).toISOString(), "grok-account");
    const failed = usageReadingSchema.parse({
      status: "unknown", reason: "billing timed out", asOf: new Date(base + 600_000).toISOString(),
      source: "grok-cli", accountId: null, windows: [],
    });
    let attempts = 0;
    const service = new UsageService(store, {
      env: {}, now: () => new Date(now),
      readers: { grok: { provider: "grok", read: async () => attempts++ === 0 ? good : failed } },
    });
    await service.refresh({ dueOnly: false });
    now = base + 600_000;
    await service.refresh({ dueOnly: false });
    const subscription = service.state().subscriptions[0]!;
    assert.deepEqual(subscription.reading, good);
    assert.equal(subscription.projection.state, "will_run_out");
    assert.deepEqual(subscription.stale, {
      reason: "billing timed out",
      failedAt: new Date(now).toISOString(),
      ageMs: 600_000,
      expired: false,
    });
    assert.match(subscription.lastError!, /billing timed out/);
  } finally {
    store.close();
  }
});

test("a failed read identifying a different account does not reuse another account's value", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "grok")]);
    store.setMeta("pool", [poolEntry("p1", "grok-1")]);
    const good = okReading([{ usedFraction: 0.7 }], "2026-11-11T12:00:00.000Z", "account-a");
    const failed = usageReadingSchema.parse({
      status: "unknown", reason: "account changed during read", asOf: "2026-11-11T12:01:00.000Z",
      source: "grok-cli", accountId: "account-b", windows: [],
    });
    let attempts = 0;
    const service = new UsageService(store, {
      env: {}, now: () => new Date("2026-11-11T12:01:00.000Z"),
      readers: { grok: { provider: "grok", read: async () => attempts++ === 0 ? good : failed } },
    });
    await service.refresh({ dueOnly: false });
    await service.refresh({ dueOnly: false });
    const subscription = service.state().subscriptions[0]!;
    assert.equal(subscription.reading.status, "unknown");
    assert.equal(subscription.stale, null);
    assert.equal(subscription.projection.state, "unknown");
  } finally {
    store.close();
  }
});

test("a last good reading stays visible after reset but its stale projection is unknown", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "grok")]);
    store.setMeta("pool", [poolEntry("p1", "grok-1")]);
    const base = Date.parse("2026-11-11T12:00:00.000Z");
    let now = base;
    const good = okReading([{
      usedFraction: 0.4,
      resetsAt: new Date(base + 1_000).toISOString(),
    }], new Date(base).toISOString());
    const failed = usageReadingSchema.parse({
      status: "unknown", reason: "offline", asOf: new Date(base + 2_000).toISOString(),
      source: "grok-cli", accountId: null, windows: [],
    });
    let attempts = 0;
    const service = new UsageService(store, {
      env: {}, now: () => new Date(now),
      readers: { grok: { provider: "grok", read: async () => attempts++ === 0 ? good : failed } },
    });
    await service.refresh({ dueOnly: false });
    now = base + 2_000;
    await service.refresh({ dueOnly: false });
    const subscription = service.state().subscriptions[0]!;
    assert.deepEqual(subscription.reading, good);
    assert.equal(subscription.projection.state, "unknown");
    assert.equal(subscription.projection.dial, null);
    assert.equal(subscription.stale?.expired, true);
    assert.equal(subscription.stale?.ageMs, 2_000);
  } finally {
    store.close();
  }
});

test("the paced tick reads only due subscriptions", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex"), profile("p2", "grok")]);
    store.setMeta("pool", [
      poolEntry("p1", "codex-pro"),
      poolEntry("p2", "grok-1"),
    ]);
    const read: string[] = [];
    const tracker = (provider: "codex" | "grok"): ProviderUsageReader => ({
      provider,
      read: async () => {
        read.push(provider);
        return okReading([{ usedFraction: 0.5 }]);
      },
    });
    let at = Date.parse("2026-11-11T12:00:00.000Z");
    const now = () => new Date(at);
    const service = new UsageService(store, {
      env: {},
      now,
      readIntervalMs: { codex: 5 * 60_000, grok: 10 * 60_000 },
      readers: { codex: tracker("codex"), grok: tracker("grok") },
    });
    // First tick: everything is due.
    await service.tick();
    assert.deepEqual(read.sort(), ["codex", "grok"]);
    // Advance one minute: nothing is due yet.
    at += 60_000;
    read.length = 0;
    await service.tick();
    assert.deepEqual(read, []);
    // Advance past Codex's five-minute cadence: only Codex is due.
    at += 5 * 60_000;
    await service.tick();
    assert.deepEqual(read, ["codex"]);
    read.length = 0;
    // At Grok's ten-minute cadence Grok is due while Codex (next due at eleven minutes) is not.
    at += 4 * 60_000;
    await service.tick();
    assert.deepEqual(read, ["grok"]);
  } finally {
    store.close();
  }
});

test("retention bounds the stored samples to the window", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex")]);
    store.setMeta("pool", [poolEntry("p1", "codex-pro")]);
    const base = Date.parse("2026-11-11T12:00:00.000Z");
    const insert = (sampledAt: string) =>
      store.db
        .prepare(
          "INSERT INTO usage_samples(group_id,provider,account_id,window_id,used_fraction,window_seconds,window_starts_at,resets_at,sampled_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "codex-pro",
          "codex",
          null,
          "weekly",
          0.5,
          null,
          null,
          null,
          sampledAt,
          "app-server",
        );
    insert(new Date(base - USAGE_SAMPLE_RETENTION_MS - 60_000).toISOString());
    insert(new Date(base - USAGE_SAMPLE_RETENTION_MS + 60_000).toISOString());
    insert(new Date(base).toISOString());
    // A prune ran yesterday, so the next tick's daily gate lets it run now.
    store.setMeta("usagePrunedAt", base - 24 * 60 * 60_000);
    const service = new UsageService(store, {
      env: {},
      now: () => new Date(base),
      readers: { codex: { provider: "codex", read: async () => okReading() } },
    });
    await service.tick();
    const rows = store.db
      .prepare("SELECT sampled_at FROM usage_samples ORDER BY sampled_at")
      .all() as Array<{ sampled_at: string }>;
    assert.equal(rows.length, 2);
    assert.ok(
      Date.parse(rows[0]!.sampled_at) >= base - USAGE_SAMPLE_RETENTION_MS,
    );
    // A second tick within the day prunes nothing again.
    await service.tick();
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get()!.n,
      2,
    );
  } finally {
    store.close();
  }
});

test("a reader that throws still records an unknown reading and its backoff", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex")]);
    store.setMeta("pool", [poolEntry("p1", "codex-pro")]);
    const service = new UsageService(store, {
      env: {},
      now: () => new Date(Date.parse("2026-11-11T12:00:00.000Z")),
      readers: {
        codex: {
          provider: "codex",
          read: async () => {
            throw new Error("spawn failed");
          },
        },
      },
    });
    await service.refresh({ dueOnly: false });
    const state = service.state();
    assert.equal(state.subscriptions[0]!.reading.status, "unknown");
    assert.match(state.subscriptions[0]!.reading.reason!, /spawn failed/);
    assert.match(state.subscriptions[0]!.lastError!, /spawn failed/);
  } finally {
    store.close();
  }
});

test("a moved clock cannot push the next read into the past", async () => {
  const { store } = fixture();
  try {
    store.setProfiles([profile("p1", "codex")]);
    store.setMeta("pool", [poolEntry("p1", "codex-pro")]);
    let at = Date.parse("2026-11-11T12:00:00.000Z");
    const service = new UsageService(store, {
      env: {},
      now: () => new Date(at),
      readers: {
        codex: {
          provider: "codex",
          read: async () => okReading([{ usedFraction: 0.5 }]),
        },
      },
    });
    await service.refresh({ dueOnly: false });
    const scheduled = service.state().subscriptions[0]!.nextReadAt!;
    // Roll the clock back well before the scheduled read: the subscription is simply not due.
    at = Date.parse(scheduled) - 10 * 60_000;
    const read: string[] = [];
    const counting = new UsageService(store, {
      env: {},
      now: () => new Date(at),
      readers: {
        codex: {
          provider: "codex",
          read: async () => {
            read.push("codex");
            return okReading([{ usedFraction: 0.6 }]);
          },
        },
      },
    });
    await counting.tick();
    assert.deepEqual(read, []);
    at = Date.parse(scheduled) + 1_000;
    await counting.tick();
    assert.deepEqual(read, ["codex"]);
  } finally {
    store.close();
  }
});
