import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { submissionSchema, type Run } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { hostIdFromDataDir } from "../shared/host-operation";

test("the only online host can be selected while another known host is offline, with durable provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-selection-"));
  const client = { isConnected: false };
  const adapter = {
    client,
    isConnected: () => client.isConnected,
    hostId: "a",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {
      client.isConnected = true;
    },
    close: async () => {
      client.isConnected = false;
    },
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => adapter,
    timers: false,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    const token = runtime.hostRegistry.connect("b", "endpoint-b", {
      adapter,
      admission: runtime.admission,
    });
    runtime.hostRegistry.disconnect("b", token);
    assert.equal(runtime.engine.selectIngressHost(), "a");
    assert.equal(runtime.engine.selectIngressHost("b"), "b");
    const payload = { type: "review_entry", input: {} };
    const implicit = await runtime.engine.startOperation({
      key: "implicit",
      kind: "review_entry",
      payload,
      deferSchedule: true,
    });
    const explicit = await runtime.engine.startOperation({
      key: "explicit",
      kind: "review_entry",
      payload,
      hostId: "b",
      deferSchedule: true,
    });
    if (!("accepted" in implicit) || !("accepted" in explicit))
      throw Error("backpressured");
    assert.deepEqual(implicit.operation.hostSelection, {
      hostId: "a",
      basis: "sole_online_host",
    });
    assert.deepEqual(explicit.operation.hostSelection, {
      hostId: "b",
      basis: "explicit",
    });
    const submission = submissionSchema.parse({
      submissionId: "selection",
      title: "Task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "h",
      originAgentId: "origin",
    });
    const task = runtime.store.insert(submission, "b", "h", "a".repeat(40), {
      hostSelection: explicit.operation.hostSelection,
    });
    const run: Run = {
      id: "run",
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head: "",
      base: "",
      agentId: null,
      workspaceId: "ws",
      profile: null,
      status: "intent",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    };
    runtime.store.putRun(run);
    assert.deepEqual(
      runtime.store.run("run")?.hostSelection,
      explicit.operation.hostSelection,
    );
    runtime.store.putRun(run);
    assert.deepEqual(
      runtime.store.run("run")?.hostSelection,
      explicit.operation.hostSelection,
    );
  } finally {
    await runtime.drain();
  }
});

test("a repository hostKind selects the unique online host of that kind with durable provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-kind-selection-"));
  const client = { isConnected: true };
  const adapter = {
    client,
    isConnected: () => client.isConnected,
    hostId: "paseo-primary",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {
      client.isConnected = true;
    },
    close: async () => {
      client.isConnected = false;
    },
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => adapter,
    timers: false,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    const t3 = {
      client: { isConnected: true },
      isConnected: () => true,
      hostId: "t3code:env",
      socketPath: join(dir, "t3.sock"),
      helperPath: join(dir, "t3-helper.mjs"),
      connect: async () => {},
      close: async () => {},
      catalog: async () => ({ providers: [] }),
    } as unknown as Adapter;
    runtime.hostRegistry.connect("t3code:env", "endpoint-t3", {
      adapter: t3,
      admission: runtime.admission,
    });
    runtime.store.putRepository(
      { origin: null, path: "/repo" },
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    assert.equal(
      runtime.engine.selectIngressHost(undefined, "/repo"),
      "t3code:env",
    );
    const accepted = await runtime.engine.startOperation({
      key: "kind",
      kind: "review_entry",
      payload: { type: "review_entry", input: {} },
      repoPath: "/repo",
      deferSchedule: true,
    });
    if (!("accepted" in accepted)) throw Error("backpressured");
    assert.deepEqual(accepted.operation.hostSelection, {
      hostId: "t3code:env",
      basis: "repository_override",
      reason: "Repository host override t3code",
    });

    runtime.store.putRepository(
      { origin: "acme/origin-only", path: "" },
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "t3code",
    );
    assert.equal(
      runtime.engine.selectIngressHost(
        undefined,
        "/different-checkout",
        "acme/origin-only",
      ),
      "t3code:env",
    );
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/origin-only.git"],
      { cwd: checkout },
    );
    const submission = submissionSchema.parse({
      submissionId: "origin-only-submission",
      title: "Origin only",
      repoPath: checkout,
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    });
    const submitted = await runtime.engine.startOperation({
      key: "origin-submission",
      kind: "submit",
      repoPath: checkout,
      deferSchedule: true,
      payload: { type: "submit", submission },
    });
    if (!("accepted" in submitted)) throw Error("backpressured");
    assert.deepEqual(submitted.operation.hostSelection, {
      hostId: "t3code:env",
      basis: "repository_override",
      reason: "Repository host override t3code",
    });
    const promoted = await runtime.engine.startOperation({
      key: "origin-promotion",
      kind: "source_promote",
      repoPath: "/different-checkout",
      deferSchedule: true,
      payload: {
        type: "source_promote",
        source: {
          kind: "lead",
          id: "lead-1",
          repository: "acme/origin-only",
          version: 1,
          digest: "a".repeat(64),
        },
        request: {
          id: "lead-1",
          repository: "acme/origin-only",
          board: true,
          note: "",
        },
      },
    });
    if (!("accepted" in promoted)) throw Error("backpressured");
    assert.deepEqual(promoted.operation.hostSelection, {
      hostId: "t3code:env",
      basis: "repository_override",
      reason: "Repository host override t3code",
    });

    runtime.store.setMeta("operatorDefaultHostKind", "paseo");
    const noSettings = await runtime.engine.startOperation({
      key: "no-settings",
      kind: "review_entry",
      repoPath: "/unconfigured",
      payload: { type: "review_entry", input: {} },
      deferSchedule: true,
    });
    if (!("accepted" in noSettings)) throw Error("backpressured");
    assert.deepEqual(noSettings.operation.hostSelection, {
      hostId: "paseo-primary",
      basis: "operator_default",
      reason: "Operator default host paseo",
    });
  } finally {
    await runtime.drain();
  }
});

test("a bb repository hostKind selects the online BB host, never rehosts a live task, and leaves Paseo the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-selection-bb-"));
  const adapter = {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "paseo-primary",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => adapter,
    timers: false,
  });
  try {
    await runtime.started;
    await runtime.bootstrap;
    // Spec 062 phase 1: the host is registered only from a verified identity probe,
    // and this is the runtime side of that acceptance.
    const bbDataDir = join(dir, "bb-data");
    const bbHostId = hostIdFromDataDir(bbDataDir);
    const connectedAt = new Date().toISOString();
    assert.deepEqual(
      runtime.bbHostVerified({
        hostId: bbHostId,
        dataDir: bbDataDir,
        bbVersion: "0.49.0",
        sdkVersion: "0.6.132",
        hostIds: ["host_synthetic"],
        connectedAt,
      }),
      { ok: true },
    );
    assert.deepEqual(
      runtime.hostRegistry.onlineIds().sort(),
      ["paseo-primary", bbHostId].sort(),
      "both hosts hold a registry claim",
    );
    const health = runtime.health();
    assert.equal(health.bb?.online, true);
    assert.equal(health.bb?.hosts[0]?.bbVersion, "0.49.0");
    assert.deepEqual(
      health.hosts?.find((host) => host.id === bbHostId),
      { id: bbHostId, state: "online", reason: "" },
    );

    // Phase 1 kept BB out of the ambient primary-host slot; phase 3 later enabled
    // work through an explicitly selected BB host context.
    assert.equal(
      runtime.engine.hostAvailable(bbHostId),
      false,
      "a secondary BB host is not the ambient primary host",
    );
    assert.equal(
      runtime.engine.withHost(bbHostId, () =>
        runtime.engine.hostAvailable(bbHostId),
      ),
      true,
      "a configured BB work route is available inside its selected host context",
    );
    assert.equal(
      runtime.engine.hostIngressAvailable(bbHostId),
      true,
      "an online BB host can receive authenticated submission ingress",
    );
    assert.equal(
      runtime.hostRegistry.shouldShutdown(0),
      false,
      "a live BB claim keeps the daemon from idling down",
    );
    assert.equal(
      runtime.engine.hostAvailable("paseo-primary"),
      true,
      "the Paseo host stays the work host",
    );

    // A repository that opted into BB selects it with durable provenance.
    runtime.store.putRepository(
      { origin: null, path: "/bb-repo" },
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "bb",
    );
    assert.equal(
      runtime.engine.selectIngressHost(undefined, "/bb-repo"),
      bbHostId,
    );
    const accepted = await runtime.engine.startOperation({
      key: "bb-kind",
      kind: "review_entry",
      repoPath: "/bb-repo",
      payload: { type: "review_entry", input: {} },
      deferSchedule: true,
    });
    if (!("accepted" in accepted)) throw Error("backpressured");
    assert.deepEqual(accepted.operation.hostSelection, {
      hostId: bbHostId,
      basis: "repository_override",
      reason: "Repository host override bb",
    });

    // When an operator explicitly sets Paseo as default, an unconfigured repository uses it.
    runtime.store.setMeta("operatorDefaultHostKind", "paseo");
    const unconfigured = await runtime.engine.startOperation({
      key: "default-kind",
      kind: "review_entry",
      repoPath: "/unconfigured",
      payload: { type: "review_entry", input: {} },
      deferSchedule: true,
    });
    if (!("accepted" in unconfigured)) throw Error("backpressured");
    assert.deepEqual(unconfigured.operation.hostSelection, {
      hostId: "paseo-primary",
      basis: "operator_default",
      reason: "Operator default host paseo",
    });

    // A live task keeps the host it started on when the repository setting changes.
    const submission = submissionSchema.parse({
      submissionId: "bb-switch",
      title: "Task",
      repoPath: "/paseo-repo",
      planningCommit: "a".repeat(40),
      handoffPath: "h",
      originAgentId: "origin",
    });
    const task = runtime.store.insert(
      submission,
      "paseo-primary",
      "h",
      "a".repeat(40),
    );
    assert.equal(runtime.store.task(task.id).hostId, "paseo-primary");
    runtime.store.setMeta("operatorDefaultHostKind", "bb");
    assert.equal(
      runtime.store.task(task.id).hostId,
      "paseo-primary",
      "changing the operator default never rehosts a live task",
    );
    runtime.store.putRepository(
      { origin: null, path: "/paseo-repo" },
      null,
      "",
      null,
      null,
      null,
      undefined,
      undefined,
      "bb",
    );
    assert.equal(
      runtime.store.task(task.id).hostId,
      "paseo-primary",
      "switching the setting never rehosts a live task",
    );

    // A dropped executor connection retires the claim and health names it offline.
    runtime.bbHostReleased({
      hostId: bbHostId,
      connectedAt,
      reason: "the host executor connection closed",
    });
    const offline = runtime.health();
    assert.equal(offline.bb?.online, false);
    assert.match(offline.bb?.offlineReason ?? "", /closed/);
    assert.equal(
      offline.hosts?.find((host) => host.id === bbHostId)?.state,
      "offline",
    );
    assert.equal(
      runtime.engine.hostIngressAvailable(bbHostId),
      false,
      "a disconnected BB host cannot accept ingress",
    );
  } finally {
    await runtime.drain();
  }
});

test("a BB host verified before the Paseo bootstrap never becomes the primary host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-selection-bb-first-"));
  const adapter = {
    client: { isConnected: true },
    isConnected: () => true,
    hostId: "paseo-primary",
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "helper.mjs"),
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: dir,
    adapterFactory: () => adapter,
    timers: false,
  });
  const bbDataDir = join(dir, "bb-data-first");
  const bbHostId = hostIdFromDataDir(bbDataDir);
  try {
    // The BB plugin can connect before the daemon's own bootstrap has registered
    // Paseo. It is registered first on purpose, and it must stay a secondary host.
    assert.deepEqual(
      runtime.bbHostVerified({
        hostId: bbHostId,
        dataDir: bbDataDir,
        bbVersion: "0.49.0",
        sdkVersion: "0.6.132",
        hostIds: ["host_synthetic"],
        connectedAt: new Date().toISOString(),
      }),
      { ok: true },
    );
    assert.deepEqual(
      runtime.hostRegistry.known().map((host) => host.id),
      [bbHostId],
      "the BB host is recorded first",
    );
    assert.equal(
      runtime.hostRegistry.legacyPaseoPrimary(),
      undefined,
      "no Paseo host means no primary host yet",
    );

    await runtime.started;
    await runtime.bootstrap;
    // The daemon's identity guard reads the primary host, so registering BB first must
    // not refuse the Paseo connection or rehost the legacy identity.
    assert.equal(
      runtime.startError,
      "",
      `the Paseo bootstrap is not refused: ${runtime.startError}`,
    );
    assert.deepEqual(
      runtime.hostRegistry.known().map((host) => host.id),
      [bbHostId, "paseo-primary"],
    );
    assert.equal(runtime.hostRegistry.legacyPaseoPrimary()?.id, "paseo-primary");
    const health = runtime.health();
    assert.equal(
      health.hostId,
      "paseo-primary",
      "the legacy hostId is still the Paseo daemon",
    );
    assert.equal(health.bb?.online, true);
    assert.deepEqual(
      health.hosts?.find((host) => host.id === bbHostId)?.state,
      "online",
    );
  } finally {
    await runtime.drain();
  }
});
