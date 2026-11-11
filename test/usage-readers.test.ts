import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexUsage, readCodexRollout } from "../core/usage/codex-reader";
import { readClaudeUsage } from "../core/usage/claude-reader";
import { readGrokUsage } from "../core/usage/grok-reader";

function scratch(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return dir;
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
    ["seven_day"],
  );
  assert.equal(reading.windows[0]!.usedFraction, 0.57);
  assert.equal(reading.windows[0]!.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(
    reading.windows[0]!.resetsAt,
    new Date(Date.parse("2026-11-14T09:00:00.101354+00:00")).toISOString(),
  );
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
        utilization: { five_hour: null, seven_day: { utilization: "many" } },
      },
    }),
  );
  const reading = await readClaudeUsage({ home: dir }, { env: {} });
  assert.equal(reading.status, "unknown");
  assert.match(reading.reason!, /no usable window/);
});

test("the grok reader reads the single credit gauge and billing period", async () => {
  const dir = scratch("usage-grok");
  const script = join(dir, "grok-fixture.mjs");
  writeFileSync(
    script,
    `
    process.stdout.write(JSON.stringify({
      creditUsagePercent: 12.5,
      currentPeriod: { start: '2026-10-28T00:00:00Z', end: '2026-11-28T00:00:00Z' },
      subscriptionTier: 'pro',
    }));
  `,
  );
  const reading = await readGrokUsage({
    command: process.execPath,
    args: [script],
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
});

test("the grok reader turns failures into unknown readings with the reason", async () => {
  const failing = scratch("usage-grok-fail");
  const failScript = join(failing, "grok-fail.mjs");
  writeFileSync(
    failScript,
    "console.error('Error: plan usage unavailable here'); process.exit(1);",
  );
  const failed = await readGrokUsage({
    command: process.execPath,
    args: [failScript],
    env: {},
  });
  assert.equal(failed.status, "unknown");
  assert.match(failed.reason!, /exited 1/);
  assert.match(failed.reason!, /plan usage unavailable/);

  const noisy = scratch("usage-grok-noisy");
  const noisyScript = join(noisy, "grok-noisy.mjs");
  writeFileSync(
    noisyScript,
    "process.stdout.write('Error: `grok usage` cannot show usage yet'); process.exit(0);",
  );
  const noJson = await readGrokUsage({
    command: process.execPath,
    args: [noisyScript],
    env: {},
  });
  assert.equal(noJson.status, "unknown");
  assert.match(noJson.reason!, /no JSON/);

  const sparse = scratch("usage-grok-sparse");
  const sparseScript = join(sparse, "grok-sparse.mjs");
  writeFileSync(
    sparseScript,
    "process.stdout.write(JSON.stringify({ currentPeriod: {} }));",
  );
  const noGauge = await readGrokUsage({
    command: process.execPath,
    args: [sparseScript],
    env: {},
  });
  assert.equal(noGauge.status, "unknown");
  assert.match(noGauge.reason!, /creditUsagePercent/);

  const missing = await readGrokUsage({
    command: "definitely-not-a-real-usage-binary-xyz",
    args: ["usage", "--json"],
    env: {},
  });
  assert.equal(missing.status, "unknown");
  assert.match(missing.reason!, /failed/);
});
