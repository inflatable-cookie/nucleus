import { observeIdle } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { importHostProfiles } from "../core/planning/profile-import";
import { QueueRuntime } from "../service/runtime-owner";
import type { Adapter } from "../core/host";
import {
  hostCatalogSchema,
  type HostCatalog,
  type HostProvider,
} from "../shared/host";
import {
  nucleusProfileSchema,
  profileAvailability,
  type NucleusProfile,
} from "../shared/profiles";

/**
 * Spec 052, step 1 of the Paseo split: Nucleus keeps its own profile list,
 * imported once from the host, and computes availability per host catalog.
 * Selection uses the stored list with host-catalog availability.
 */

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nsq-profiles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const profile = (overrides: Partial<NucleusProfile> = {}): NucleusProfile =>
  nucleusProfileSchema.parse({
    id: "sol",
    name: "Sol",
    provider: "openai",
    model: "gpt-5",
    notes: "",
    ...overrides,
  });

const provider = (overrides: Partial<HostProvider> = {}): HostProvider => ({
  key: "openai",
  label: "OpenAI",
  available: true,
  problem: "",
  models: [
    {
      id: "gpt-5",
      label: "GPT-5",
      aliases: ["gpt-5-latest"],
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
      modes: [],
      features: [],
    },
  ],
  ...overrides,
});
const catalog = (...providers: HostProvider[]): HostCatalog =>
  hostCatalogSchema.parse({ providers });

/** The host list as Paseo reports it, before Nucleus's schema normalises it. */
const hostProfile = (overrides: Record<string, unknown> = {}) => ({
  id: "paseo-sol",
  name: "Sol",
  provider: "openai-codex",
  model: "gpt-5",
  notes: "paseo notes",
  ...overrides,
});

/* ------------------------------------------------------------------------- */
/* Availability: a stored profile read against one host's catalog              */
/* ------------------------------------------------------------------------- */

test("Spec 052 availability: a table of launch values and catalogs", () => {
  const table: {
    label: string;
    profile: NucleusProfile;
    catalog: HostCatalog;
    available: boolean;
    problem: string;
    supportedThinking?: string[];
  }[] = [
    {
      label: "provider, model and thinking all present",
      profile: profile({ thinkingOptionId: "low" }),
      catalog: catalog(provider()),
      available: true,
      problem: "",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a model alias counts as the model",
      profile: profile({ model: "gpt-5-latest" }),
      catalog: catalog(provider()),
      available: true,
      problem: "",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a host without the provider",
      profile: profile({ provider: "anthropic" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Provider anthropic is not available on this host",
      supportedThinking: [],
    },
    {
      label: "a host without the model, even when another provider has it",
      profile: profile({ model: "opus" }),
      catalog: catalog(
        provider(),
        provider({ key: "anthropic", label: "Anthropic" }),
      ),
      available: false,
      problem: "Model opus is not available from provider openai",
      supportedThinking: [],
    },
    {
      label: "no model chosen",
      profile: profile({ model: "" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Profile needs an explicit model",
      supportedThinking: [],
    },
    {
      label: "a thinking level the model does not offer",
      profile: profile({ thinkingOptionId: "max" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Configured thinking level is not supported",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a provider the host reports unusable",
      profile: profile(),
      catalog: catalog(
        provider({ available: false, problem: "API key missing" }),
      ),
      available: false,
      problem: "API key missing",
      supportedThinking: [],
    },
  ];
  for (const row of table) {
    assert.deepEqual(
      profileAvailability(row.profile, row.catalog),
      {
        available: row.available,
        problem: row.problem,
        supportedThinking: row.supportedThinking ?? [],
      },
      row.label,
    );
  }
});

/* ------------------------------------------------------------------------- */
/* The one-time import                                                        */
/* ------------------------------------------------------------------------- */

test("Spec 052 import: a fresh store copies the host list with ids unchanged and records the run", (t) => {
  const store = new Store(join(fixture(t), "queue.sqlite"));
  try {
    const result = importHostProfiles(store, {
      source: "host",
      at: "2026-11-07T00:00:00.000Z",
      hostProfiles: [
        hostProfile(),
        hostProfile({ id: "paseo-luna", name: "Luna", model: undefined }),
      ],
    });
    assert.ok(result);
    assert.deepEqual(result.record, {
      at: "2026-11-07T00:00:00.000Z",
      source: "host",
      imported: 2,
      kept: 0,
      skipped: 0,
    });
    assert.deepEqual(store.profiles(), [
      {
        id: "paseo-sol",
        name: "Sol",
        provider: "openai-codex",
        model: "gpt-5",
        notes: "paseo notes",
      },
      {
        id: "paseo-luna",
        name: "Luna",
        provider: "openai-codex",
        model: "",
        notes: "paseo notes",
      },
    ]);
    assert.deepEqual(store.profileImportRecord(), result.record);
  } finally {
    store.close();
  }
});

test("Spec 052 import: a second run does nothing, and a later host change imports nothing", (t) => {
  const store = new Store(join(fixture(t), "queue.sqlite"));
  try {
    const first = importHostProfiles(store, {
      source: "host",
      at: "2026-11-07T00:00:00.000Z",
      hostProfiles: [hostProfile()],
    });
    assert.equal(first?.record.imported, 1);
    // Paseo's profiles changed after the import: the run is recorded, so nothing moves.
    assert.equal(
      importHostProfiles(store, {
        source: "host",
          hostProfiles: [
          hostProfile({ name: "Sol (renamed in Paseo)" }),
          hostProfile({ id: "paseo-new", name: "New" }),
        ],
      }),
      null,
    );
    assert.deepEqual(
      store.profiles().map((profile) => [profile.id, profile.name]),
      [["paseo-sol", "Sol"]],
    );
    assert.equal(store.profileImportRecord()?.at, "2026-11-07T00:00:00.000Z");
  } finally {
    store.close();
  }
});

test("Spec 052 import: a Nucleus edit survives a later Paseo change, and an existing Nucleus profile is never overwritten", (t) => {
  const store = new Store(join(fixture(t), "queue.sqlite"));
  try {
    // A profile Nucleus already holds under an id the host also names.
    store.setProfiles([
      profile({ id: "paseo-sol", name: "Nucleus Sol", notes: "kept" }),
    ]);
    const result = importHostProfiles(store, {
      source: "host",
      hostProfiles: [
        hostProfile({ name: "Paseo Sol" }),
        hostProfile({ id: "paseo-luna", name: "Luna" }),
      ],
    });
    assert.ok(result);
    assert.deepEqual([result.record.imported, result.record.kept], [1, 1]);
    assert.deepEqual(result.kept, ["paseo-sol"]);
    assert.equal(
      store.profiles().find((profile) => profile.id === "paseo-sol")?.name,
      "Nucleus Sol",
    );
    // A Nucleus edit after the import is the list that is kept.
    const edited = store
      .profiles()
      .map((profile) =>
        profile.id === "paseo-luna"
          ? { ...profile, name: "Luna (Nucleus)", notes: "edited" }
          : profile,
      );
    store.setProfiles(edited);
    assert.equal(
      importHostProfiles(store, {
        source: "host",
          hostProfiles: [hostProfile({ name: "Paseo Sol again" })],
      }),
      null,
    );
    assert.equal(
      store.profiles().find((profile) => profile.id === "paseo-luna")?.name,
      "Luna (Nucleus)",
    );
  } finally {
    store.close();
  }
});

test("task 1158 import: Paseo's spellings move to canonical values, an unknown one is kept, and an invalid host entry is left out", (t) => {
  const store = new Store(join(fixture(t), "queue.sqlite"));
  try {
    const result = importHostProfiles(store, {
      source: "host",
      hostProfiles: [
        hostProfile({ provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions" }),
        hostProfile({ id: "grok", provider: "grok", model: "grok-4.6", featureValues: { auto_accept: true } }),
        hostProfile({ id: "broken", name: "" }),
      ],
    });
    assert.ok(result);
    assert.deepEqual([result.record.imported, result.record.skipped], [2, 1]);
    assert.deepEqual(store.profiles().map(item => [item.provider, item.modeId, item.featureValues]),
      [["claude", "full-access", undefined], ["grok", "full-access", undefined]]);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------------- */
/* The RPC surface and the runtime's one import                               */
/* ------------------------------------------------------------------------- */

function fakeAdapter(
  dir: string,
  catalogValue: HostCatalog,
  hostProfiles: () => unknown[],
): Adapter {
  return {
    client: { isConnected: true },
    hostId: "fixture-host",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-report.mjs"),
    connect: async () => {},
    close: async () => {},
    profiles: async () => [],
    observe: observeIdle("ws", "worker"),
    hostProfiles: async () => hostProfiles() as NucleusProfile[],
    catalog: async () => catalogValue,
  } as unknown as Adapter;
}

test("Spec 052: the profile RPCs list, create, update and remove stored records, and read the catalog and the canonical vocabulary", async (t) => {
  const dir = fixture(t);
  const listed: string[] = [];
  const catalogReads: ({ cwd?: string } | undefined)[] = [];
  const runtime = new QueueRuntime({
    dataDir: dir,
    timers: false,
    adapterFactory: () => {
      const adapter = fakeAdapter(dir, catalog(provider()), () => {
        listed.push("read");
        return [hostProfile()];
      });
      (
        adapter as unknown as {
          catalog: (options?: { cwd?: string }) => Promise<HostCatalog>;
        }
      ).catalog = async (options) => {
        catalogReads.push(options);
        return catalog(provider());
      };
      return adapter;
    },
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    // The earlier migration's stored records are the source; refresh never reads the host list.
    runtime.store.setProfiles([nucleusProfileSchema.parse(hostProfile())]);
    await runtime.refresh();
    assert.deepEqual(listed, []);
    assert.deepEqual(runtime.profileList().profiles.map(profile => profile.name), ["Sol"]);

    const created = runtime.profileCreate({
      name: "Luna",
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
    });
    assert.ok(created.profile.id);
    assert.deepEqual(created.profile, {
      id: created.profile.id,
      name: "Luna",
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "low",
      notes: "",
    });
    assert.equal(runtime.profileList().profiles.length, 2);
    assert.throws(
      () =>
        runtime.profileCreate({
          id: "paseo-sol",
          name: "Duplicate",
          provider: "codex",
        }),
      /already exists/,
    );

    const updated = runtime.profileUpdate({
      id: created.profile.id,
      name: "Luna Two",
      thinkingOptionId: null,
      notes: "note",
    });
    assert.deepEqual(updated.profile, {
      id: created.profile.id,
      name: "Luna Two",
      provider: "codex",
      model: "gpt-5",
      notes: "note",
    });
    assert.throws(
      () => runtime.profileUpdate({ id: "absent", name: "Nothing" }),
      /does not exist/,
    );

    const { readAt, ...read } = await runtime.hostCatalog({});
    assert.deepEqual(read, catalog(provider()));
    assert.ok(Number.isFinite(Date.parse(readAt)));
    await runtime.hostCatalog({ cwd: "/repo" });
    assert.deepEqual(catalogReads.slice(-2), [{}, { cwd: "/repo" }]);
    // The form's vocabulary (task 1158): a host key outside the canonical corpus
    // is not offered, and a canonical one carries canonical levels and labels.
    assert.deepEqual((await runtime.profileVocabulary({})).providers, []);

    assert.deepEqual(runtime.profileRemove({ id: created.profile.id }), {
      removed: true,
    });
    assert.deepEqual(runtime.profileRemove({ id: created.profile.id }), {
      removed: false,
    });
    assert.deepEqual(
      runtime.profileList().profiles.map((profile) => profile.id),
      ["paseo-sol"],
    );
  } finally {
    await runtime.drain();
  }
});

test("nucleus#970: host.catalog answers from the stored catalog, and Refresh replaces it", async (t) => {
  const dir = fixture(t);
  const catalogReads: ({ cwd?: string } | undefined)[] = [];
  let answer: HostCatalog | Error = catalog(provider());
  let client: { isConnected: boolean } | null = null;
  const runtime = new QueueRuntime({
    dataDir: dir,
    timers: false,
    adapterFactory: () => {
      const adapter = fakeAdapter(dir, catalog(provider()), () => []);
      client = (adapter as unknown as { client: { isConnected: boolean } }).client;
      (adapter as unknown as { catalog: (options?: { cwd?: string }) => Promise<HostCatalog> }).catalog = async (options) => {
        catalogReads.push(options);
        if (answer instanceof Error) throw answer;
        return answer;
      };
      return adapter;
    },
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    const hostReads = () => catalogReads.filter(read => read && "cwd" in read).length;

    // Nothing stored: the first read goes to the host and stores its answer.
    const first = await runtime.hostCatalog({ cwd: "/repo" });
    assert.equal(hostReads(), 1);
    assert.equal(first.providers[0]?.label, "OpenAI");

    // Stored: the next read answers without a host call, with the same read time.
    answer = catalog(provider({ label: "OpenAI renamed" }));
    const stored = await runtime.hostCatalog({ cwd: "/repo" });
    assert.equal(hostReads(), 1);
    assert.deepEqual(stored, first);

    // Another directory is its own stored catalog.
    await runtime.hostCatalog({ cwd: "/other" });
    assert.equal(hostReads(), 2);

    // Refresh reads the host live and replaces the stored catalog.
    const refreshed = await runtime.hostCatalog({ cwd: "/repo", refresh: true });
    assert.equal(hostReads(), 3);
    assert.equal(refreshed.providers[0]?.label, "OpenAI renamed");
    assert.deepEqual(await runtime.hostCatalog({ cwd: "/repo" }), refreshed);
    assert.equal(hostReads(), 3);

    // A failed refresh refuses with the host's reason and keeps the stored catalog.
    answer = new Error("host catalog timed out");
    await assert.rejects(runtime.hostCatalog({ cwd: "/repo", refresh: true }), /host catalog timed out/);
    assert.deepEqual(await runtime.hostCatalog({ cwd: "/repo" }), refreshed);

    // A disconnected daemon refuses a live read; the stored catalog still answers with its read time.
    answer = catalog(provider());
    client!.isConnected = false;
    await assert.rejects(runtime.hostCatalog({ cwd: "/repo", refresh: true }), /disconnected/i);
    await assert.rejects(runtime.hostCatalog({ cwd: "/never-read" }), /disconnected/i);
    assert.deepEqual(await runtime.hostCatalog({ cwd: "/repo" }), refreshed);
  } finally {
    await runtime.drain();
  }
});
