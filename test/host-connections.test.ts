import { test } from "node:test";
import assert from "node:assert/strict";
import { HostConnections, wireEngineHosts } from "../service/host-connections";
import { HostRegistry } from "../core/host/host-registry";
import { Admission } from "../core/host/admission";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "../core/host/adapter";
import type {
  HostConnectionOwner,
  RegisteredHost,
} from "../service/host-connections";

function registry() {
  let known: { id: string; endpoint: string }[] = [];
  return new HostRegistry<RegisteredHost>({
    read: () => known,
    write: (value) => {
      known = [...value];
    },
    transaction: (work) => work(),
  });
}

test("connected retires a mismatched Paseo claim and anyHostConnected counts the registry", () => {
  const hosts = registry();
  const adapter = { isConnected: () => false } as unknown as Adapter;
  const admission = new Admission();
  const token = hosts.connect("paseo-env", "ws://127.0.0.1/ws", {
    adapter,
    admission,
  });
  const owner = {
    adapter,
    hostSession: { id: "paseo-env", token },
    hostRegistry: hosts,
    t3Host: null,
    // Spec 062 phase 1: the runtime's BB claim owner. This stub has no BB host, so the
    // registry is the only thing anyHostConnected counts here.
    bbHost: { retireDisconnected() {}, connected: () => false },
    bootstrapped: true,
    closing: false,
    idleShutdownLatched: false,
    bootstrapRunning: null,
    serveHostRunEndpoint: false,
    hostRunEndpoint: null,
    hostRuns: { liveRuns: () => [] },
    store: {
      getMeta: () => null,
      setMeta() {},
      deleteMeta() {},
      advanceRevision() {},
      projectPlannerRecipient: () => null,
      queueProject: () => null,
    },
    engine: {} as Engine,
    pluginLostGraceMs: 1,
    paseoHostId: "paseo-env",
  } as unknown as HostConnectionOwner;
  const connections = new HostConnections(owner);
  assert.equal(connections.connected(), false);
  assert.equal(owner.hostSession, null);
  assert.equal(owner.bootstrapped, false);
  assert.equal(connections.anyHostConnected(), false);
});

test("connected clears bootstrapped once on primary disconnect while a secondary host stays online (nucleus#1449)", () => {
  const hosts = registry();
  const paseo = { isConnected: () => false } as unknown as Adapter;
  const t3 = { isConnected: () => true } as unknown as Adapter;
  const admission = new Admission();
  const paseoToken = hosts.connect("paseo:primary", "ws://127.0.0.1/ws", {
    adapter: paseo,
    admission,
  });
  hosts.connect("t3code:trial", "t3code-endpoint", { adapter: t3, admission });
  const owner = {
    adapter: paseo,
    hostSession: { id: "paseo:primary", token: paseoToken },
    hostRegistry: hosts,
    t3Host: null,
    bbHost: { retireDisconnected() {}, connected: () => false },
    bootstrapped: true,
    closing: false,
    idleShutdownLatched: false,
    bootstrapRunning: null,
    serveHostRunEndpoint: false,
    hostRunEndpoint: null,
    hostRuns: { liveRuns: () => [] },
    store: {
      getMeta: () => null,
      setMeta() {},
      deleteMeta() {},
      advanceRevision() {},
      projectPlannerRecipient: () => null,
      queueProject: () => null,
    },
    engine: {} as Engine,
    pluginLostGraceMs: 1,
    paseoHostId: "paseo:primary",
  } as unknown as HostConnectionOwner;
  const connections = new HostConnections(owner);
  // Retiring an active primary session un-proves bootstrap once so common recovery runs.
  assert.equal(connections.connected(), false);
  assert.equal(owner.hostSession, null);
  assert.equal(owner.bootstrapped, false);
  assert.equal(connections.anyHostConnected(), true);
  // Once that recovery pass settles, later ticks while primary stays offline keep bootstrapped true.
  owner.bootstrapped = true;
  assert.equal(connections.connected(), false);
  assert.equal(owner.bootstrapped, true);
});

test("wireEngineHosts refuses an unregistered explicit host and resolves a lone online host", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || "", "host-connections-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const adapter = {
    isConnected: () => false,
    observe: async (id: string) => ({
      id,
      workspaceId: null,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const hosts = registry();
  hosts.connect("only-host", "ws://127.0.0.1/ws", {
    adapter,
    admission: new Admission(),
  });
  try {
    wireEngineHosts(engine, {
      adapter,
      hostRegistry: hosts,
      hostSession: null,
      connected: () => true,
      store,
    });
    assert.equal(engine.selectIngressHost(), "only-host");
    assert.throws(() => engine.selectIngressHost("missing"), /not registered/);
  } finally {
    void engine.stop();
    store.close();
  }
});

function presenceFixture(options?: {
  paseoConnected?: boolean;
  pluginLostGraceMs?: number;
}) {
  const hosts = registry();
  const meta = new Map<string, unknown>();
  const notices: { hostId: string; agentId: string; text: string }[] = [];
  let paseoOnline = options?.paseoConnected ?? false;
  const paseoAdapter = {
    isConnected: () => paseoOnline,
    notify: async () => {},
  } as unknown as Adapter;
  const admission = new Admission();
  let revisions = 0;
  const project = {
    key: "nucleus",
    name: "Nucleus",
    repositories: [{ origin: "https://example.com/nucleus", path: "/nucleus" }],
  };
  let activeHostId = "";
  const owner = {
    adapter: paseoAdapter,
    hostSession: null,
    hostRegistry: hosts,
    t3Host: null,
    bbHost: { retireDisconnected() {}, connected: () => false },
    bootstrapped: true,
    closing: false,
    idleShutdownLatched: false,
    bootstrapRunning: null,
    serveHostRunEndpoint: false,
    hostRunEndpoint: null,
    hostRuns: { liveRuns: () => [] },
    store: {
      getMeta: <T>(key: string) => (meta.get(key) as T | undefined) ?? null,
      setMeta: (key: string, value: unknown) => {
        meta.set(key, value);
      },
      deleteMeta: (key: string) => {
        meta.delete(key);
      },
      advanceRevision: () => {
        revisions++;
      },
      projectPlannerRecipient: () => null,
      queueProject: () => project,
    },
    engine: {
      resolution: {
        responsibleThread: async () => ({
          thread: { hostId: "t3code:trial", agentId: "planner-1" },
        }),
        responsibleThreads: { cache: { invalidate() {} } },
      },
      withHost: async <T>(hostId: string, work: () => Promise<T>) => {
        activeHostId = hostId;
        return await work();
      },
      host: {
        sendMessage: async (
          agentId: string,
          input: { messageId: string; text: string },
        ) => {
          notices.push({ hostId: activeHostId, agentId, text: input.text });
        },
      },
    } as unknown as Engine,
    pluginLostGraceMs: options?.pluginLostGraceMs ?? 10,
    paseoHostId: "paseo:primary",
  } as unknown as HostConnectionOwner;
  if (paseoOnline) {
    const token = hosts.connect("paseo:primary", "ws://127.0.0.1/ws", {
      adapter: paseoAdapter,
      admission,
    });
    owner.hostSession = { id: "paseo:primary", token };
  }
  const connections = new HostConnections(owner);
  return {
    hosts,
    meta,
    notices,
    owner,
    connections,
    admission,
    revisions: () => revisions,
    setPaseoOnline: (online: boolean) => {
      paseoOnline = online;
    },
  };
}

test("T3-only hostPresenceClosed does not arm or raise a Paseo plugin fault", async () => {
  const f = presenceFixture({ paseoConnected: false, pluginLostGraceMs: 10 });
  const t3Adapter = { isConnected: () => true } as unknown as Adapter;
  f.hosts.connect("t3code:trial", "t3code-endpoint", {
    adapter: t3Adapter,
    admission: f.admission,
  });

  f.connections.hostPresenceClosed();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(f.meta.get("pluginPresenceFault"), undefined);
  assert.equal(f.connections.pluginPresenceFaultMessage(), "");
  assert.equal(f.notices.length, 0);
});

test("BB alongside T3 raises BB plugin wording and reload command, and clears when BB leaves", async () => {
  const f = presenceFixture({ paseoConnected: false, pluginLostGraceMs: 10 });
  const t3Adapter = { isConnected: () => true } as unknown as Adapter;
  const bbAdapter = { isConnected: () => true } as unknown as Adapter;
  f.hosts.connect("t3code:trial", "t3code-endpoint", {
    adapter: t3Adapter,
    admission: f.admission,
  });
  const bbToken = f.hosts.connect("bb:abc", "bb-data-dir:/tmp/bb", {
    adapter: bbAdapter,
    admission: f.admission,
  });

  f.connections.hostPresenceClosed();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.match(
    f.connections.pluginPresenceFaultMessage(),
    /while BB is still connected/,
  );
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!.text, /while BB is still connected/);
  assert.match(f.notices[0]!.text, /bb plugin reload nucleus/);
  assert.doesNotMatch(f.notices[0]!.text, /paseo plugin reload nucleus/);
  assert.deepEqual(
    (
      f.meta.get("pluginPresenceFault") as {
        hostIds?: string[];
        hostKinds?: string[];
      }
    )?.hostIds,
    ["bb:abc"],
  );

  // When BB leaves while T3 stays online, the BB-owned fault clears.
  f.hosts.disconnect("bb:abc", bbToken);
  assert.equal(f.connections.anyHostConnected(), true);
  assert.equal(f.connections.pluginPresenceFaultMessage(), "");
  assert.equal(f.meta.get("pluginPresenceFault"), undefined);
});

test("Paseo leaving clears a Paseo-owned fault even when BB or T3 stays online, including legacy faults", async () => {
  const f = presenceFixture({ paseoConnected: true, pluginLostGraceMs: 10 });
  const bbAdapter = { isConnected: () => true } as unknown as Adapter;
  f.hosts.connect("bb:abc", "bb-data-dir:/tmp/bb", {
    adapter: bbAdapter,
    admission: f.admission,
  });

  f.connections.hostPresenceClosed();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.match(
    f.connections.pluginPresenceFaultMessage(),
    /while Paseo is still connected/,
  );
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!.text, /paseo plugin reload nucleus/);
  assert.match(f.notices[0]!.text, /bb plugin reload nucleus/);

  // Paseo leaves while BB stays online without presence: stale Paseo fault clears
  // immediately, and BB raises its own BB-specific fault after the grace period.
  f.setPaseoOnline(false);
  assert.equal(f.connections.anyHostConnected(), true);
  assert.equal(f.meta.get("pluginPresenceFault"), undefined);
  assert.equal(f.connections.pluginPresenceFaultMessage(), "");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(
    f.connections.pluginPresenceFaultMessage(),
    /while BB is still connected/,
  );
  assert.equal(f.notices.length, 2);
  assert.match(f.notices[1]!.text, /bb plugin reload nucleus/);
  assert.doesNotMatch(f.notices[1]!.text, /paseo plugin reload nucleus/);

  // Legacy stored fault without hostIds/hostKinds also clears when only T3 is online.
  const legacy = presenceFixture({
    paseoConnected: false,
    pluginLostGraceMs: 10,
  });
  const t3Adapter = { isConnected: () => true } as unknown as Adapter;
  legacy.hosts.connect("t3code:trial", "t3code-endpoint", {
    adapter: t3Adapter,
    admission: legacy.admission,
  });
  legacy.meta.set("pluginPresenceFault", {
    at: new Date().toISOString(),
    message:
      "The Nucleus plugin is not present while Paseo is still connected. The recovery thread cannot act while the plugin is down.",
  });
  assert.equal(legacy.connections.pluginPresenceFaultMessage(), "");
  assert.equal(legacy.meta.get("pluginPresenceFault"), undefined);
});
