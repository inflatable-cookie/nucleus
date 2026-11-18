/**
 * `nucleus t3 install` / `status` / `uninstall` (nucleus#1330) against the fake
 * Nightly transport and a fake installed `t3` command.
 *
 * Every case drives the real CLI front door (`bin/nucleus-t3.mjs`) as a child
 * process, so the argument shapes, the owner-only settings write, the refusals
 * and the printed report are the shipped ones. The server answers with the
 * Nightly's stored shapes: `server.getConfig` carries `settings.providerInstances`
 * and `providers`, and `server.updateSettings` applies the provider mutation the
 * nightly documents. The fake `t3` CLI records the sessions the route minted, so
 * the scope split and the rotation are read from what was actually issued.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { t3Fake } from "./support/t3code-fake";
import { t3HttpOrigin } from "../bin/t3-install";
import {
  liveTaskNames,
  liveTaskRefusal,
  t3StatusReport,
} from "../shared/t3/operator";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "bin", "nucleus-t3.mjs");
const fakeT3Cli = join(repoRoot, "test", "support", "t3-cli-fake.mjs");

function scratchRoot(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(root, "the run scratch volume is required");
  return realpathSync(root);
}

interface Fixture {
  directory: string;
  dataDir: string;
  baseDir: string;
  acpCommand: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const directory = mkdtempSync(join(scratchRoot(), "t3-install-"));
  const dataDir = join(directory, "ns");
  const baseDir = join(directory, "t3");
  const stateDir = join(directory, "t3-cli-state");
  const acpCommand = join(directory, "bin", "nucleus-acp");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  mkdirSync(dirname(acpCommand), { recursive: true });
  writeFileSync(
    acpCommand,
    '#!/bin/sh\n# nucleus-owned-command-v1\nexec "$HOME/bin/node" "$HOME/bin/nucleus-acp.mjs" "$@"\n',
    { mode: 0o755 },
  );
  chmodSync(acpCommand, 0o755);
  return {
    directory,
    dataDir,
    baseDir,
    acpCommand,
    stateDir,
    env: {
      ...process.env,
      NUCLEUS_DATA_HOME: dataDir,
      T3_CLI_FAKE_STATE: stateDir,
      T3CODE_HOME: baseDir,
    },
  };
}

function writeDescriptor(target: Fixture, endpoint: string) {
  writeFileSync(
    join(target.baseDir, "userdata", "server-runtime.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      origin: endpoint,
      serverVersion: "nightly-synthetic",
    }),
  );
}

async function runCli(
  target: Fixture,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, "t3", ...args], {
      cwd: repoRoot,
      env: target.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolveRun({ code: code ?? 1, stdout, stderr }),
    );
  });
}

const installArgs = (target: Fixture) => [
  "install",
  "--base-dir",
  target.baseDir,
  "--t3",
  fakeT3Cli,
  "--acp-command",
  target.acpCommand,
  "--json",
];
const statusArgs = (target: Fixture) => [
  "status",
  "--base-dir",
  target.baseDir,
  "--t3",
  fakeT3Cli,
  "--acp-command",
  target.acpCommand,
  "--json",
];
const uninstallArgs = (target: Fixture) => [
  "uninstall",
  "--live-tasks",
  "--base-dir",
  target.baseDir,
  "--t3",
  fakeT3Cli,
  "--acp-command",
  target.acpCommand,
  "--json",
];

function settingsFile(target: Fixture): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(target.dataDir, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
}

function sessions(target: Fixture): Array<{
  sessionId: string;
  token: string;
  scopes: string[];
  subject: string | null;
  label: string | null;
  ttl: string | null;
  revokedAt?: string;
}> {
  const path = join(target.stateDir, "sessions.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

function calls(fake: Awaited<ReturnType<typeof t3Fake>>, tag: string) {
  return fake.requests.filter((request) => request.tag === tag);
}

/** One stored instance this install owns, as the nightly keeps it in its settings. */
function ownedInstance(acpCommand: string) {
  return {
    driver: "acpRegistry",
    displayName: "Nucleus",
    enabled: true,
    config: { source: "local", commandPath: acpCommand },
  };
}

function readyRow(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: "nucleus",
    displayName: "Nucleus",
    driver: "acpRegistry",
    enabled: true,
    status: "ready",
    models: [
      { slug: "nucleus", name: "Nucleus" },
      { slug: "nucleus-quiet", name: "Nucleus (quiet)" },
    ],
    ...overrides,
  };
}

test("install mints the two bearers, registers our provider and stores the runtime connection", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  const result = await runCli(target, installArgs(target));
  assert.equal(result.code, 0, result.stderr);
  const answer = JSON.parse(result.stdout) as {
    hostId: string;
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  };
  assert.equal(answer.hostId, "t3code:synthetic-environment");
  assert.match(
    answer.steps.map((step) => `${step.step}: ${step.detail}`).join("\n"),
    /T3Code server: http:\/\/127\.0\.0\.1:\d+/,
  );
  assert.match(
    answer.steps.map((step) => `${step.step}: ${step.detail}`).join("\n"),
    /registered nucleus \(acpRegistry\), command .*nucleus-acp, enabled, ready, models nucleus/,
  );

  // One mutation, ours, through T3's own route and nothing else.
  const mutations = calls(fake, "server.updateSettings");
  assert.equal(mutations.length, 1);
  const payload = mutations[0]!.payload as {
    patch: unknown;
    providerInstanceMutation: {
      operation: string;
      instanceId: string;
      instance: unknown;
    };
  };
  assert.deepEqual(payload.patch, {});
  assert.equal(payload.providerInstanceMutation.operation, "upsert");
  assert.equal(payload.providerInstanceMutation.instanceId, "nucleus");
  assert.deepEqual(payload.providerInstanceMutation.instance, {
    driver: "acpRegistry",
    displayName: "Nucleus",
    enabled: true,
    config: { source: "local", commandPath: target.acpCommand },
  });

  // The bearer that wrote carried the install session; the one stored is the runtime session.
  const issued = sessions(target);
  const installSession = issued.find((row) =>
    row.scopes.includes("providers:manage"),
  );
  const runtimeSession = issued.find((row) =>
    row.scopes.includes("orchestration:operate"),
  );
  assert.ok(installSession, "the install session is recorded by the fake CLI");
  assert.ok(runtimeSession, "the runtime session is recorded by the fake CLI");
  assert.deepEqual(runtimeSession!.scopes, [
    "orchestration:read",
    "orchestration:operate",
  ]);
  assert.ok(!runtimeSession!.scopes.includes("settings:write"));
  assert.ok(!runtimeSession!.scopes.includes("providers:manage"));
  // The socket that wrote fetched its ticket with the install bearer: the scope
  // split is the session store's own fact, not a claim in the output.
  assert.deepEqual(fake.bearers, [`Bearer ${installSession!.token}`]);

  const stored = settingsFile(target);
  const connection = stored.t3code as {
    endpoint: string;
    bearer: string;
    sessionId: string;
  };
  assert.equal(connection.endpoint, fake.endpoint);
  assert.equal(connection.bearer, runtimeSession!.token);
  assert.equal(connection.sessionId, runtimeSession!.sessionId);
  assert.equal(
    statSync(join(target.dataDir, "settings.json")).mode & 0o777,
    0o600,
  );
  assert.ok(
    !result.stdout.includes(runtimeSession!.token),
    "the bearer is never printed",
  );
  assert.ok(
    !result.stdout.includes(installSession!.token),
    "the install bearer is never printed",
  );
  // The install bearer's session is revoked straight after registration.
  assert.ok(
    issued.find((row) => row.sessionId === installSession!.sessionId)
      ?.revokedAt,
    "the install session is revoked",
  );
  assert.equal(
    issued.find((row) => row.sessionId === runtimeSession!.sessionId)
      ?.revokedAt,
    undefined,
    "the runtime session stays active",
  );

  const status = await runCli(target, statusArgs(target));
  assert.equal(status.code, 0, status.stderr);
  const report = JSON.parse(status.stdout) as {
    ok: boolean;
    provider: {
      registered: boolean;
      ours: boolean;
      enabled: boolean;
      ready: boolean;
      commandMatchesInstalled: boolean;
      models: string[];
    };
    bearer: { present: boolean; valid: boolean | null; scopes: string[] };
  };
  assert.equal(report.ok, true);
  assert.equal(report.provider.registered, true);
  assert.equal(report.provider.ours, true);
  assert.equal(report.provider.enabled, true);
  assert.equal(report.provider.ready, true);
  assert.equal(report.provider.commandMatchesInstalled, true);
  assert.deepEqual(report.provider.models, ["nucleus", "nucleus-quiet"]);
  assert.equal(report.bearer.present, true);
  assert.deepEqual(report.bearer.scopes, [
    "orchestration:read",
    "orchestration:operate",
  ]);
  assert.ok(
    !status.stdout.includes(runtimeSession!.token),
    "status never prints the bearer",
  );
});

test("a second install rotates the runtime bearer and re-checks the same instance", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  const first = await runCli(target, installArgs(target));
  assert.equal(first.code, 0, first.stderr);
  const firstSession = sessions(target).find((row) =>
    row.scopes.includes("orchestration:read"),
  )!;
  const second = await runCli(target, installArgs(target));
  assert.equal(second.code, 0, second.stderr);
  const remaining = sessions(target);
  const runtime = remaining.filter(
    (row) => row.scopes.includes("orchestration:read") && !row.revokedAt,
  );
  assert.equal(runtime.length, 1, "exactly one runtime session stays active");
  assert.notEqual(
    runtime[0]!.sessionId,
    firstSession.sessionId,
    "the runtime bearer was rotated",
  );
  assert.ok(
    remaining.find((row) => row.sessionId === firstSession.sessionId)
      ?.revokedAt,
    "the previous session was revoked",
  );
  assert.equal(
    (settingsFile(target).t3code as { sessionId: string }).sessionId,
    runtime[0]!.sessionId,
  );
  const mutations = calls(fake, "server.updateSettings");
  assert.equal(mutations.length, 2);
  for (const mutation of mutations)
    assert.equal(
      (mutation.payload as { providerInstanceMutation: { operation: string } })
        .providerInstanceMutation.operation,
      "upsert",
    );
});

test("install succeeds while T3 reports its own ACP probe warning, and reports the probe's words", async (t) => {
  // The installed nightly answers a provider upsert with `ready`, then its own ACP
  // probe opens a *test session* in a directory Nucleus has not bound and reports
  // `warning`. That is T3's verdict about a state this route cannot control, so the
  // route reports it verbatim instead of claiming a readiness it cannot reach.
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  fake.controls.upsertProviderStatus = "ready";
  fake.controls.upsertProviderMessage =
    "Checking ACP authentication, models, and commands in the background…";
  const transition = setInterval(() => {
    if (fake.controls.providers?.some((row) => row.instanceId === "nucleus")) {
      fake.controls.providers = [
        readyRow({
          status: "warning",
          models: [{ slug: "default" }],
          message: "The ACP agent could not create a test session.",
        }),
      ];
      clearInterval(transition);
    }
  }, 500);
  t.after(() => clearInterval(transition));
  const result = await runCli(target, installArgs(target));
  assert.equal(result.code, 0, result.stderr);
  const answer = JSON.parse(result.stdout) as {
    steps: Array<{ step: string; ok: boolean; detail: string }>;
  };
  const lines = answer.steps
    .map((step) => `${step.step}: ${step.detail}`)
    .join("\n");
  assert.ok(
    calls(fake, "server.getConfig").length >= 3,
    "the in-progress probe was polled again",
  );
  assert.match(
    lines,
    /Provider instance: registered nucleus .*enabled, warning/,
  );
  assert.match(lines, /The ACP agent could not create a test session\./);
  assert.match(
    lines,
    /Provider readiness: T3Code reports warning: The ACP agent could not create a test session\./,
  );
  const status = await runCli(target, statusArgs(target));
  const report = JSON.parse(status.stdout) as {
    ok: boolean;
    provider: {
      usable: boolean;
      ready: boolean;
      status: string;
      probeMessage: string;
    };
  };
  assert.equal(report.ok, true, "a warning is not a broken install");
  assert.equal(report.provider.usable, true);
  assert.equal(report.provider.ready, false);
  assert.equal(report.provider.status, "warning");
  assert.equal(
    report.provider.probeMessage,
    "The ACP agent could not create a test session.",
  );
});

test("a namesake provider instance is refused by name and never overwritten", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  fake.controls.providerInstances = {
    nucleus: {
      driver: "codex",
      enabled: true,
      config: { binaryPath: "/opt/synthetic/codex" },
    },
  };
  fake.controls.providers = [
    readyRow({ driver: "codex", models: [{ slug: "gpt", name: "GPT" }] }),
  ];
  const result = await runCli(target, installArgs(target));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /provider instance named nucleus that is not this install's \(driver codex, commandPath none\)/,
  );
  assert.equal(
    calls(fake, "server.updateSettings").length,
    0,
    "nothing was written",
  );
  assert.ok(
    !existsSync(join(target.dataDir, "settings.json")),
    "no connection was stored",
  );
  assert.ok(
    sessions(target).every((row) => Boolean(row.revokedAt)),
    "the install bearer was revoked",
  );
  assert.equal(
    fake.controls.providerInstances.nucleus.driver,
    "codex",
    "the namesake is untouched",
  );
});

test("an acpRegistry instance pointing at someone else's command is refused too", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  fake.controls.providerInstances = {
    nucleus: {
      driver: "acpRegistry",
      enabled: true,
      config: { source: "local", commandPath: "/opt/synthetic/other-acp" },
    },
  };
  fake.controls.providers = [readyRow()];
  const result = await runCli(target, installArgs(target));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /not this install's \(driver acpRegistry, commandPath \/opt\/synthetic\/other-acp\)/,
  );
  assert.equal(calls(fake, "server.updateSettings").length, 0);
});

test("status reports a missing, a disabled and a foreign provider, and a near-expiry bearer", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  const installed = await runCli(target, installArgs(target));
  assert.equal(installed.code, 0, installed.stderr);
  const runtime = sessions(target).find((row) =>
    row.scopes.includes("orchestration:operate"),
  )!;

  // A provider that is not there at all.
  fake.controls.providerInstances = {};
  fake.controls.providers = [];
  const missing = await runCli(target, statusArgs(target));
  assert.equal(missing.code, 0, missing.stderr);
  const missingReport = JSON.parse(missing.stdout) as {
    ok: boolean;
    provider: { registered: boolean; problem: string };
    problems: string[];
  };
  assert.equal(missingReport.provider.registered, false);
  assert.match(
    missingReport.provider.problem,
    /no T3Code provider instance named nucleus is registered/,
  );
  assert.equal(missingReport.ok, false);
  assert.ok(
    !missing.stdout.includes(runtime.token),
    "status never prints the bearer",
  );

  // Ours, but the operator turned it off.
  fake.controls.providerInstances = {
    nucleus: ownedInstance(target.acpCommand),
  };
  fake.controls.providers = [readyRow({ enabled: false, status: "disabled" })];
  const disabled = await runCli(target, statusArgs(target));
  const disabledReport = JSON.parse(disabled.stdout) as {
    ok: boolean;
    provider: {
      registered: boolean;
      ours: boolean;
      enabled: boolean;
      problem: string;
    };
  };
  assert.equal(disabledReport.provider.registered, true);
  assert.equal(disabledReport.provider.ours, true);
  assert.equal(disabledReport.provider.enabled, false);
  assert.match(disabledReport.provider.problem, /is disabled/);
  assert.equal(disabledReport.ok, false);

  // A namesake that is not this install's.
  fake.controls.providerInstances = {
    nucleus: { driver: "codex", enabled: true, config: {} },
  };
  fake.controls.providers = [readyRow({ driver: "codex" })];
  const foreign = await runCli(target, statusArgs(target));
  const foreignReport = JSON.parse(foreign.stdout) as {
    provider: { registered: boolean; ours: boolean; problem: string };
  };
  assert.equal(foreignReport.provider.registered, true);
  assert.equal(foreignReport.provider.ours, false);
  assert.match(foreignReport.provider.problem, /is not this install's/);

  // A ready instance of ours whose bearer is nearly expired.
  fake.controls.providerInstances = {
    nucleus: ownedInstance(target.acpCommand),
  };
  fake.controls.providers = [readyRow()];
  const store = sessions(target).map((row) =>
    row.sessionId === runtime.sessionId
      ? {
          ...row,
          expiresAt: new Date(
            Date.now() + 2 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }
      : row,
  );
  writeFileSync(
    join(target.stateDir, "sessions.json"),
    JSON.stringify(store, null, 2),
  );
  const near = await runCli(target, statusArgs(target));
  const nearReport = JSON.parse(near.stdout) as {
    ok: boolean;
    bearer: { nearExpiry: boolean; expiresInDays: number; problem: string };
  };
  assert.equal(nearReport.bearer.nearExpiry, true);
  assert.ok(nearReport.bearer.expiresInDays <= 2);
  assert.match(nearReport.bearer.problem, /expires in \d+ day\(s\)/);
});

test("uninstall removes only our instance and our sessions, and clears the connection", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  assert.equal((await runCli(target, installArgs(target))).code, 0);
  const projectsBefore = JSON.parse(JSON.stringify(fake.projects));
  const result = await runCli(target, uninstallArgs(target));
  assert.equal(result.code, 0, result.stderr);
  const mutations = calls(fake, "server.updateSettings");
  const removal = mutations.at(-1)!.payload as {
    patch: unknown;
    providerInstanceMutation: { operation: string; instanceId: string };
  };
  assert.deepEqual(removal.patch, {});
  assert.deepEqual(removal.providerInstanceMutation, {
    operation: "remove",
    instanceId: "nucleus",
  });
  assert.equal(
    fake.controls.providerInstances?.nucleus,
    undefined,
    "the provider instance is gone",
  );
  assert.equal(
    settingsFile(target).t3code,
    undefined,
    "the stored connection is cleared",
  );
  assert.ok(
    sessions(target).length > 0 &&
      sessions(target).every((row) => Boolean(row.revokedAt)),
    "every Nucleus session was revoked",
  );
  assert.deepEqual(
    fake.projects,
    projectsBefore,
    "no project registration was touched",
  );
  assert.equal(calls(fake, "projects.mutate").length, 0);
  assert.equal(calls(fake, "thread.archive").length, 0);
  assert.equal(calls(fake, "thread.delete").length, 0);
});

test("uninstall refuses a foreign instance and leaves it alone", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  fake.controls.providerInstances = {
    nucleus: { driver: "codex", enabled: true, config: {} },
  };
  fake.controls.providers = [readyRow({ driver: "codex" })];
  const result = await runCli(target, uninstallArgs(target));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not this install's/);
  assert.equal(calls(fake, "server.updateSettings").length, 0);
  assert.equal(fake.controls.providerInstances.nucleus.driver, "codex");
});

test("uninstall refuses while tasks are live on the host, and names them", () => {
  const names = liveTaskNames([
    { kind: "task", label: "Tasks", names: ["nucleus#1301", "nucleus#1302"] },
    { kind: "project", label: "Projects", names: ["synthetic/project"] },
  ]);
  const refusal = liveTaskRefusal("t3code:synthetic-environment", names, false);
  assert.match(
    refusal ?? "",
    /still has live tasks: nucleus#1301, nucleus#1302/,
  );
  assert.match(refusal ?? "", /--live-tasks/);
  assert.equal(
    liveTaskRefusal("t3code:synthetic-environment", ["nucleus#1301"], true),
    null,
  );
  assert.equal(
    liveTaskRefusal("t3code:synthetic-environment", [], false),
    null,
  );
});

test("the status report carries the adapter native-parenting line and the projects opted into T3Code", () => {
  const report = t3StatusReport({
    endpoint: "http://127.0.0.1:3773",
    acpCommand: null,
    connection: null,
    config: null,
    serverError: "connection refused",
    sessions: null,
    bearerAccepted: null,
    service: {
      available: true,
      connected: true,
      hostId: "t3code:synthetic-environment",
      error: "",
      nativeParenting: "native parenting: nucleus provider ready",
      supportThreads: "support threads hidden",
    },
    projects: [
      { name: "github.com/synthetic/opted-in", hostKind: "t3code" },
      { name: "github.com/synthetic/paseo", hostKind: "paseo" },
    ],
  });
  assert.equal(report.provider.registered, null);
  assert.equal(report.server.reachable, false);
  assert.match(report.server.problem, /connection refused/);
  assert.equal(
    report.service.nativeParenting,
    "native parenting: nucleus provider ready",
  );
  assert.deepEqual(report.projects, [
    { name: "github.com/synthetic/opted-in" },
  ]);
  assert.equal(report.ok, false);
});

test("an unmarked executable is refused before any write", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  writeFileSync(target.acpCommand, "#!/bin/sh\nexit 0\n");
  const result = await runCli(target, installArgs(target));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing the nucleus-owned-command-v1 marker/);
  assert.equal(calls(fake, "server.updateSettings").length, 0);
  assert.ok(!existsSync(join(target.dataDir, "settings.json")));
  const status = await runCli(target, statusArgs(target));
  assert.equal(JSON.parse(status.stdout).acp.owned, false);
});

test("status probes a reachable server without a stored connection", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  const result = await runCli(target, statusArgs(target));
  const report = JSON.parse(result.stdout);
  assert.equal(report.server.reachable, true);
  assert.equal(report.server.environmentId, "synthetic-environment");
  assert.equal(report.bearer.present, false);
});

test("uninstall refuses without changes when the server is down", async () => {
  const target = fixture();
  const endpoint = "http://127.0.0.1:1";
  writeDescriptor(target, endpoint);
  writeFileSync(
    join(target.dataDir, "settings.json"),
    JSON.stringify({ t3code: { endpoint, bearer: "synthetic-bearer" } }),
  );
  const result = await runCli(target, uninstallArgs(target));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Uninstall made no changes; the stored runtime bearer remains active/,
  );
  assert.equal(
    (settingsFile(target).t3code as { bearer: string }).bearer,
    "synthetic-bearer",
  );
});

test("CLI launcher cannot impersonate ACP and cannot remove a matching foreign provider", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  writeFileSync(
    target.acpCommand,
    '#!/bin/sh\n# nucleus-owned-command-v1\nroot="$HOME/.local/share/nucleus/current"\nexec "$root/runtime/node" "$root/bin/nucleus.mjs" "$@"\n',
  );
  fake.controls.providerInstances = {
    nucleus: ownedInstance(target.acpCommand),
  };
  fake.controls.providers = [readyRow()];
  const install = await runCli(target, installArgs(target));
  assert.equal(install.code, 1);
  const uninstall = await runCli(target, uninstallArgs(target));
  assert.equal(uninstall.code, 1);
  assert.match(uninstall.stderr, /not this install/);
  assert.equal(calls(fake, "server.updateSettings").length, 0);
  assert.equal(
    JSON.parse((await runCli(target, statusArgs(target))).stdout).acp.owned,
    false,
  );
});

test("uninstall refuses unknown service state unless explicitly overridden", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  assert.equal((await runCli(target, installArgs(target))).code, 0);
  const noOverride = uninstallArgs(target).filter(
    (arg) => arg !== "--live-tasks",
  );
  const refused = await runCli(target, noOverride);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot be ruled out/);
  assert.ok(settingsFile(target).t3code);
  const allowed = await runCli(target, uninstallArgs(target));
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(settingsFile(target).t3code, undefined);
});

test("a second T3 environment never receives the stored bearer or clears its connection", async (t) => {
  const target = fixture();
  const first = await t3Fake(t, target.directory);
  const second = await t3Fake(t, target.directory);
  second.controls.environmentId = "other-environment";
  writeDescriptor(target, first.endpoint);
  assert.equal((await runCli(target, installArgs(target))).code, 0);
  const old = JSON.stringify(settingsFile(target));
  const status = await runCli(target, [
    ...statusArgs(target),
    "--endpoint",
    second.endpoint,
  ]);
  assert.equal(JSON.parse(status.stdout).provider.registered, null);
  assert.equal(second.bearers.length, 0);
  const result = await runCli(target, [
    ...uninstallArgs(target),
    "--endpoint",
    second.endpoint,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /differs from the stored connection/);
  assert.equal(second.bearers.length, 0);
  assert.equal(JSON.stringify(settingsFile(target)), old);
});

test("legacy endpoint-and-bearer settings are checked and migrated or removed", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  const writeLegacy = () =>
    writeFileSync(
      join(target.dataDir, "settings.json"),
      JSON.stringify({
        t3code: { endpoint: fake.endpoint, bearer: "synthetic-legacy-bearer" },
      }),
    );
  writeLegacy();
  const status = JSON.parse((await runCli(target, statusArgs(target))).stdout);
  assert.equal(status.bearer.valid, true);
  assert.deepEqual(status.bearer.scopes, []);
  assert.equal(status.bearer.expiresAt, null);
  const install = await runCli(target, installArgs(target));
  assert.equal(install.code, 0, install.stderr);
  assert.ok((settingsFile(target).t3code as { sessionId?: string }).sessionId);
  writeLegacy();
  const uninstall = await runCli(target, uninstallArgs(target));
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(settingsFile(target).t3code, undefined);
  assert.equal(fake.controls.providerInstances?.nucleus, undefined);
});

test("a revoked runtime session reports no unrelated scopes and can rotate or uninstall", async (t) => {
  const target = fixture();
  const fake = await t3Fake(t, target.directory);
  writeDescriptor(target, fake.endpoint);
  assert.equal((await runCli(target, installArgs(target))).code, 0);
  const revokeRuntime = () => {
    const id = (settingsFile(target).t3code as { sessionId: string }).sessionId;
    const rows = sessions(target);
    const row = rows.find((candidate) => candidate.sessionId === id)!;
    row.revokedAt = new Date().toISOString();
    fake.controls.rejectBearers.push(`Bearer ${row.token}`);
    rows.push({
      sessionId: `unrelated-${id}`,
      token: "synthetic-unrelated",
      scopes: ["providers:manage"],
      subject: "nucleus",
      label: "nucleus",
      ttl: "1h",
      expiresAt: "2099-01-01T00:00:00.000Z",
    } as typeof row);
    writeFileSync(join(target.stateDir, "sessions.json"), JSON.stringify(rows));
  };
  revokeRuntime();
  const status = JSON.parse((await runCli(target, statusArgs(target))).stdout);
  assert.equal(status.bearer.valid, false);
  assert.deepEqual(status.bearer.scopes, []);
  assert.equal(status.bearer.expiresAt, null);
  assert.match(status.bearer.problem, /nucleus t3 install/);
  const install = await runCli(target, installArgs(target));
  assert.equal(install.code, 0, install.stderr);
  revokeRuntime();
  const uninstall = await runCli(target, uninstallArgs(target));
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(settingsFile(target).t3code, undefined);
});

test("legacy WebSocket connections work with or without a server descriptor", async (t) => {
  for (const descriptor of [true, false]) {
    const target = fixture();
    const fake = await t3Fake(t, target.directory);
    if (descriptor) writeDescriptor(target, fake.endpoint);
    const websocket = fake.endpoint.replace("http:", "ws:") + "/ws";
    const writeLegacy = () =>
      writeFileSync(
        join(target.dataDir, "settings.json"),
        JSON.stringify({
          t3code: { endpoint: websocket, bearer: "synthetic-legacy-bearer" },
        }),
      );
    writeLegacy();
    const status = await runCli(target, statusArgs(target));
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).bearer.valid, true);
    const install = await runCli(target, installArgs(target));
    assert.equal(install.code, 0, install.stderr);
    writeLegacy();
    const uninstall = await runCli(target, uninstallArgs(target));
    assert.equal(uninstall.code, 0, uninstall.stderr);
    assert.equal(settingsFile(target).t3code, undefined);
    assert.equal(fake.controls.providerInstances?.nucleus, undefined);
  }
});

test("WebSocket origin normalization preserves secure transport, host and port", () => {
  assert.equal(t3HttpOrigin("ws://localhost:3773/ws"), "http://localhost:3773");
  assert.equal(
    t3HttpOrigin("wss://localhost:3773/ws"),
    "https://localhost:3773",
  );
  assert.equal(t3HttpOrigin("wss://localhost:443/ws"), "https://localhost");
  assert.notEqual(
    t3HttpOrigin("wss://localhost:3773/ws"),
    t3HttpOrigin("http://localhost:3773"),
  );
  assert.notEqual(
    t3HttpOrigin("ws://localhost:3773/ws"),
    t3HttpOrigin("http://localhost:3774"),
  );
  assert.throws(() => t3HttpOrigin("ws://user:pass@localhost/ws"));
});
