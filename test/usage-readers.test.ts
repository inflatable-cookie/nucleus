import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexUsage, readCodexRollout } from "../core/usage/codex-reader";
import { readClaudeUsage } from "../core/usage/claude-reader";
import { GROK_BILLING_TIMEOUT_MS, GROK_INITIALIZE_TIMEOUT_MS, readGrokUsage } from "../core/usage/grok-reader";
import { projectUsage } from "../shared/usage-projection";

function scratch(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return dir;
}

function grokAgentFixture(
  dir: string,
  result: string | null,
  behavior = "reply",
  expectedHome: string | null = null,
) {
  const script = join(dir, "grok-agent-fixture.mjs");
  writeFileSync(script, `
    import { createInterface } from 'node:readline';
    import { readFileSync } from 'node:fs';
    const resultPath = ${JSON.stringify(result)};
    const behavior = ${JSON.stringify(behavior)};
    const expectedHome = ${JSON.stringify(expectedHome)};
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (behavior === 'silent') return;
      const response = { jsonrpc: '2.0', id: request.id };
      if (request.method === 'initialize') {
        if (request.params?.protocolVersion !== '1' || !request.params?.clientCapabilities ||
          (expectedHome !== null && process.env.GROK_HOME !== expectedHome)) {
          response.error = { code: -32602, message: 'invalid initialize parameters or Grok home' };
        } else response.result = {};
        if (behavior === 'slow-initialize') setTimeout(() => process.stdout.write(JSON.stringify(response) + '\\n'), 4100);
        else process.stdout.write(JSON.stringify(response) + '\\n');
        return;
      } else if (request.method === '_x.ai/billing' && behavior === 'unsupported') {
        response.error = { code: -32601, message: 'Method not found' };
      } else if (request.method === '_x.ai/billing') {
        response.result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } else return;
      process.stdout.write(JSON.stringify(response) + '\\n');
    });
  `);
  return { command: process.execPath, args: [script] };
}

/** A stand-in `codex` binary: answers the JSON-RPC handshake with the result file argv names. */
function codexAppServerFixture(
  dir: string,
  resultPath: string | null,
  exitAfterFirst = false,
) {
  const script = join(dir, "codex-fixture.mjs");
  writeFileSync(
    script,
    `
    import { createInterface } from 'node:readline';
    import { readFileSync } from 'node:fs';
    const resultPath = ${JSON.stringify(resultPath)};
    const rl = createInterface({ input: process.stdin });
    let first = true;
    rl.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.id) return;
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fixture' } }) + '\\n');
        return;
      }
      if (resultPath === null) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: JSON.parse(readFileSync(resultPath, 'utf8')) }) + '\\n');
      if (${exitAfterFirst} && first) { first = false; process.exit(0); }
    });
  `,
  );
  return { command: process.execPath, args: [script] };
}

test("the codex reader maps an app-server rate-limits reply into windows", async () => {
  const dir = scratch("usage-codex-rpc");
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  // Recorded shape from a read against the local CLI: synthetic account id and percentages.
  const resultPath = join(dir, "result.json");
  writeFileSync(
    resultPath,
    JSON.stringify({
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 56,
          windowDurationMins: 10080,
          resetsAt: 1794772815,
        },
        secondary: null,
        planType: "pro",
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 56,
            windowDurationMins: 10080,
            resetsAt: 1794772815,
          },
          secondary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: 1794210000,
          },
        },
      },
      accountId: "0f0e0d0c-1111-4222-8333-444455556666",
    }),
  );
  const reading = await readCodexUsage(
    { home },
    { ...codexAppServerFixture(dir, resultPath), env: {} },
  );
  assert.equal(reading.status, "ok");
  assert.equal(reading.source, "app-server");
  assert.equal(reading.accountId, "0f0e0d0c-1111-4222-8333-444455556666");
  assert.deepEqual(
    reading.windows.map((window) => window.windowId),
    ["codex:primary", "codex:secondary"],
  );
  assert.equal(reading.windows[0]!.usedFraction, 0.56);
  assert.equal(reading.windows[0]!.windowSeconds, 10080 * 60);
  assert.equal(
    reading.windows[0]!.resetsAt,
    new Date(1794772815 * 1000).toISOString(),
  );
  assert.equal(reading.windows[1]!.usedFraction, 0.1);
});

test("the codex reader survives renamed and sparse fields in the reply", async () => {
  const dir = scratch("usage-codex-renamed");
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  const resultPath = join(dir, "result.json");
  // No rateLimitsByLimitId, a renamed limit label, a primary without a window length or reset.
  writeFileSync(
    resultPath,
    JSON.stringify({
      rateLimits: {
        limitName: "Spark",
        primary: { usedPercent: 40 },
        secondary: { unexpectedPercent: 5 },
      },
      accountId: null,
    }),
  );
  const reading = await readCodexUsage(
    { home },
    { ...codexAppServerFixture(dir, resultPath), env: {} },
  );
  assert.equal(reading.status, "ok");
  assert.deepEqual(
    reading.windows.map((window) => window.windowId),
    ["Spark:primary"],
  );
  assert.equal(reading.windows[0]!.windowSeconds, null);
  assert.equal(reading.windows[0]!.resetsAt, null);
  assert.equal(reading.accountId, null);
});

test("an unreadable app-server reply falls back to the rollout tail", async () => {
  const dir = scratch("usage-codex-fallback");
  const home = join(dir, "codex-home");
  const sessions = join(home, "sessions", "2026", "11", "10");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(
    sessions,
    "rollout-2026-11-10T09-00-00-0f0e0d0c-1111-4222-8333-444455556666.jsonl",
  );
  writeFileSync(
    rollout,
    [
      JSON.stringify({
        timestamp: "2026-11-10T08:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            primary: {
              used_percent: 30,
              window_minutes: 10080,
              resets_at: 1794600000,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-10T09:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {},
          rate_limits: {
            limit_id: "codex",
            primary: {
              used_percent: 42.5,
              window_minutes: 10080,
              resets_at: 1794772815,
            },
            secondary: null,
            plan_type: "pro",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-10T09:00:01.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: {} },
      }),
    ].join("\n") + "\n",
  );
  const reading = await readCodexUsage(
    { home },
    { ...codexAppServerFixture(dir, null), env: {} },
  );
  assert.equal(reading.status, "ok");
  assert.equal(reading.source, "rollout");
  assert.equal(reading.asOf, "2026-11-10T09:00:00.000Z");
  assert.equal(reading.windows[0]!.usedFraction, 0.425);
  assert.equal(reading.windows[0]!.windowId, "codex:primary");
  assert.equal(reading.accountId, null);
});

test("a codex home with neither source reads unknown with the reason", async () => {
  const dir = scratch("usage-codex-empty");
  const home = join(dir, "empty-codex-home");
  mkdirSync(home, { recursive: true });
  const reading = await readCodexUsage(
    { home },
    { ...codexAppServerFixture(dir, null), env: {} },
  );
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason!, /no rollout event carries rate limits/);
  assert.deepEqual(reading.windows, []);
});

test("the rollout fallback skips files whose newest event carries no rate limits", () => {
  const dir = scratch("usage-codex-older");
  const home = join(dir, "codex-home");
  const sessions = join(home, "sessions");
  mkdirSync(join(sessions, "a"), { recursive: true });
  mkdirSync(join(sessions, "b"), { recursive: true });
  const noLimits = join(sessions, "a", "rollout-newer.jsonl");
  const withLimits = join(sessions, "b", "rollout-older.jsonl");
  writeFileSync(
    noLimits,
    JSON.stringify({
      timestamp: "2026-11-10T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: {} },
    }) + "\n",
  );
  writeFileSync(
    withLimits,
    JSON.stringify({
      timestamp: "2026-11-10T08:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {},
        rate_limits: {
          primary: {
            used_percent: 12,
            window_minutes: 10080,
            resets_at: 1794772815,
          },
        },
      },
    }) + "\n",
  );
  // The newer file is more recent on disk; the fallback walks to the older one.
  const later = new Date(Date.now() + 60_000);
  utimesSync(noLimits, later, later);
  const reading = readCodexRollout(home);
  assert.ok(reading);
  assert.equal(reading.status, "ok");
  assert.equal(reading.windows[0]!.usedFraction, 0.12);
});

test("the claude reader reads the cached utilization windows and sample time", async () => {
  const dir = scratch("usage-claude");
  const fetchedAtMs = Date.parse("2026-11-11T09:24:44.190Z");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "synthetic-user",
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: "1a2b3c4d-0000-4000-8000-000000000001",
        utilization: {
          five_hour: null,
          seven_day: {
            utilization: 57,
            resets_at: "2026-11-14T09:00:00.101354+00:00",
            limit_dollars: null,
          },
          seven_day_opus: {
            utilization: 10,
            resets_at: "2026-11-14T09:00:00.101354+00:00",
          },
          pace: { someFutureField: true },
          limits: [],
        },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "ok");
  assert.equal(reading.source, "claude-config");
  assert.equal(reading.asOf, new Date(fetchedAtMs).toISOString());
  assert.equal(reading.accountId, "1a2b3c4d-0000-4000-8000-000000000001");
  assert.deepEqual(
    reading.windows.map((window) => window.windowId),
    ["five_hour", "seven_day"],
  );
  assert.equal(reading.windows[0]!.notStarted, true);
  const weekly = reading.windows[1]!;
  assert.equal(weekly.usedFraction, 0.57);
  assert.equal(weekly.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(
    weekly.resetsAt,
    new Date(Date.parse("2026-11-14T09:00:00.101354+00:00")).toISOString(),
  );
});

test("Claude's null five-hour entry is a known inactive window", async () => {
  const dir = scratch("usage-claude-inactive-five-hour");
  const fetchedAtMs = Date.parse("2026-11-14T01:05:00.000Z");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "synthetic-user",
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: "1a2b3c4d-0000-4000-8000-000000000001",
        utilization: { five_hour: null },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "ok");
  assert.equal(reading.accountId, "1a2b3c4d-0000-4000-8000-000000000001");
  assert.deepEqual(reading.windows, [{
    windowId: "five_hour",
    name: "5-hour",
    usedFraction: 0,
    windowSeconds: 5 * 60 * 60,
    windowStartsAt: null,
    resetsAt: null,
    notStarted: true,
  }]);
});

test("a Claude weekly cache past reset projects as unused", async () => {
  const dir = scratch("usage-claude-weekly-past-reset");
  const fetchedAtMs = Date.parse("2026-11-14T01:05:00.000Z");
  const now = Date.parse("2026-11-14T10:00:00.000Z");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "synthetic-user",
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: "1a2b3c4d-0000-4000-8000-000000000001",
        utilization: {
          seven_day: {
            utilization: 89,
            resets_at: "2026-11-14T09:00:00.340640+00:00",
            limit_dollars: null,
          },
        },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "ok");
  assert.equal(reading.windows.length, 1);
  assert.equal(reading.windows[0]!.usedFraction, 0.89);
  assert.equal(reading.windows[0]!.resetsAt, "2026-11-14T09:00:00.340Z");
  const projection = projectUsage({ now, windows: reading.windows });
  assert.equal(projection.state, "spare");
  assert.equal(projection.dial, -1);
  assert.equal(projection.projectedUseAtReset, 0);
});

test("malformed Claude windows remain unknown", async () => {
  const dir = scratch("usage-claude-malformed-windows");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: Date.parse("2026-11-14T01:05:00.000Z"),
        accountUuid: "1a2b3c4d-0000-4000-8000-000000000001",
        utilization: {
          five_hour: { utilization: "many", resets_at: null },
          seven_day: { utilization: "many", resets_at: null },
        },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason!, /no usable window/);
});

test("the claude reader never invents data from a missing or renamed cache", async () => {
  const dir = scratch("usage-claude-missing");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "synthetic-user",
      cachedUsageUtilizationRenamed: {},
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason!, /no cachedUsageUtilization/);
  assert.deepEqual(reading.windows, []);

  const noFetchTime = scratch("usage-claude-nofetch");
  writeFileSync(
    join(noFetchTime, ".claude.json"),
    JSON.stringify({
      cachedUsageUtilization: {
        utilization: { seven_day: { utilization: 10 } },
      },
    }),
  );
  const untimed = await readClaudeUsage({ home: noFetchTime }, { env: {} });
  assert.equal(untimed.status, "unknown");
  assert.match(untimed.reason!, /fetchedAtMs/);

  const absent = scratch("usage-claude-absent");
  const unreadable = await readClaudeUsage({ home: absent }, { env: {} });
  assert.equal(unreadable.status, "not_available");
  assert.match(unreadable.reason!, /unreadable/);
});

test("the claude reader reports a cache with no usable window as unknown", async () => {
  const dir = scratch("usage-claude-empty");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: 1794413084190,
        accountUuid: null,
        utilization: {
          five_hour: { utilization: "many" },
          seven_day: { utilization: "many" },
        },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason!, /no usable window/);
});

test("the grok reader reads nested credits through agent stdio", async () => {
  assert.equal(GROK_INITIALIZE_TIMEOUT_MS, 15_000);
  assert.equal(GROK_BILLING_TIMEOUT_MS, 10_000);
  const dir = scratch("usage-grok");
  const fixturePath = new URL("./fixtures/grok-billing-current.json", import.meta.url).pathname;
  const reading = await readGrokUsage({ home: join(dir, "home") }, {
    ...grokAgentFixture(dir, fixturePath, "reply", join(dir, "home")),
    env: {},
  });
  assert.equal(reading.status, "ok");
  assert.equal(reading.source, "grok-cli");
  assert.deepEqual(
    reading.windows.map((window) => window.windowId),
    ["credits"],
  );
  assert.equal(reading.windows[0]!.usedFraction, 0.125);
  assert.equal(reading.windows[0]!.windowStartsAt, "2026-10-28T00:00:00.000Z");
  assert.equal(reading.windows[0]!.resetsAt, "2026-11-28T00:00:00.000Z");
  assert.equal(reading.windows[0]!.windowSeconds, null);
  assert.equal(reading.reason, null);
});

test("Grok agent stdio accepts a cold initialize that takes longer than four seconds", async () => {
  const dir = scratch("usage-grok-slow-initialize");
  const fixturePath = new URL("./fixtures/grok-billing-current.json", import.meta.url).pathname;
  const reading = await readGrokUsage({ home: "" }, {
    ...grokAgentFixture(dir, fixturePath, "slow-initialize"),
    env: {},
  });
  assert.equal(reading.status, "ok");
  assert.equal(reading.windows[0]!.usedFraction, 0.125);
});

test("the grok reader supports legacy billing and keeps unsupported or unparseable usage unknown", async () => {
  const dir = scratch("usage-grok-legacy");
  const fixturePath = new URL("./fixtures/grok-billing-legacy.json", import.meta.url).pathname;
  const legacy = await readGrokUsage({ home: "" }, { ...grokAgentFixture(dir, fixturePath), env: {} });
  assert.equal(legacy.status, "ok");
  assert.equal(legacy.windows[0]!.usedFraction, 0.125);
  assert.equal(legacy.windows[0]!.windowStartsAt, "2026-10-01T00:00:00.000Z");
  assert.equal(legacy.windows[0]!.resetsAt, "2026-11-01T00:00:00.000Z");

  const unsupportedDir = scratch("usage-grok-unsupported");
  const unsupported = await readGrokUsage({ home: "" }, {
    ...grokAgentFixture(unsupportedDir, null, "unsupported"),
    env: {},
  });
  assert.equal(unsupported.status, "unknown");
  assert.match(unsupported.reason!, /Method not found/);

  const sparseDir = scratch("usage-grok-sparse");
  const sparsePath = join(sparseDir, "sparse.json");
  writeFileSync(sparsePath, JSON.stringify({ config: { currentPeriod: {} } }));
  const noGauge = await readGrokUsage({ home: "" }, {
    ...grokAgentFixture(sparseDir, sparsePath),
    env: {},
  });
  assert.equal(noGauge.status, "unknown");
  assert.match(noGauge.reason!, /no numeric credit usage percent/);

  const timeoutDir = scratch("usage-grok-timeout");
  const timeout = await readGrokUsage({ home: "" }, {
    ...grokAgentFixture(timeoutDir, null, "silent"),
    env: {},
    initializeTimeoutMs: 50,
  });
  assert.equal(timeout.status, "unknown");
  assert.match(timeout.reason!, /initialize timed out/);

  const fallbackDir = scratch("usage-grok-fallback");
  const fallbackScript = join(fallbackDir, "grok-fallback.mjs");
  writeFileSync(fallbackScript, `
    if (process.argv[2] === 'usage') {
      process.stdout.write(JSON.stringify({
        creditUsagePercent: 23,
        currentPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }
      }));
    } else {
      const { createInterface } = await import('node:readline');
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'agent stdio unavailable' }
        }) + '\\n');
      });
    }
  `);
  const fallback = await readGrokUsage({ home: "" }, {
    command: process.execPath,
    args: [fallbackScript, "agent", "stdio"],
    fallbackArgs: [fallbackScript, "usage", "--json"],
    env: {},
    // This fixture runs while other reader tests, including the cold-start delay,
    // may be active under the shared test concurrency limit.
    timeoutMs: 5_000,
  });
  assert.equal(fallback.status, "ok");
  assert.equal(fallback.windows[0]!.usedFraction, 0.23);
  assert.equal(fallback.windows[0]!.resetsAt, "2026-11-01T00:00:00.000Z");

  const missing = await readGrokUsage({ home: "" }, {
    command: "definitely-not-a-real-usage-binary-xyz",
    env: {},
  });
  assert.equal(missing.status, "unknown");
  assert.match(missing.reason!, /fallback failed/);
});
