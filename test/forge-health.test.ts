import { test } from "node:test";
import assert from "node:assert/strict";
import { githubHealthy, isForgeNetworkFailure } from "../core/forge/forge-health";

test("concurrent tasks share one GitHub probe and the next probe sees recovery", async () => {
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  let clock = originalNow(),
    calls = 0,
    healthy = false;
  Date.now = () => clock;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: healthy } as Response;
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await Promise.all([githubHealthy(), githubHealthy(), githubHealthy()]),
      [false, false, false],
    );
    assert.equal(calls, 1);
    healthy = true;
    clock += 10_001;
    assert.equal(await githubHealthy(), true);
    assert.equal(calls, 2);
    assert.equal(isForgeNetworkFailure({ stderr: "HTTP 503" }), true);
    assert.equal(isForgeNetworkFailure({ code: "ECONNRESET" }), true);
    assert.equal(isForgeNetworkFailure({ stderr: "error connecting to api.github.com" }), true);
    assert.equal(isForgeNetworkFailure({ stderr: "HTTP 403" }), false);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("forge command failures wait only when the shared probe also fails", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { command } = await import("../core/git/index");
  const { ForgeOutageError } = await import("../core/forge/forge-health");
  const dir = mkdtempSync(join(tmpdir(), "forge-health-"));
  const executable = join(dir, "gh");
  writeFileSync(executable, '#!/bin/sh\necho "HTTP 503" >&2\nexit 1\n');
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH,
    oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let clock = oldNow() + 20_000,
    healthy = false,
    calls = 0;
  process.env.PATH = `${dir}:${oldPath}`;
  Date.now = () => clock;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: healthy } as Response;
  }) as typeof fetch;
  try {
    const results = await Promise.allSettled([
      command("gh", ["api", "user"], dir),
      command("gh", ["api", "user"], dir),
    ]);
    assert.ok(
      results.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ForgeOutageError,
      ),
    );
    assert.equal(calls, 1);
    healthy = true;
    clock += 10_001;
    await assert.rejects(
      command("gh", ["api", "user"], dir),
      (error) => !(error instanceof ForgeOutageError),
    );
    assert.equal(calls, 2);
    const { gitDeliveryUnknown } = await import('../core/forge/forge-health');
    await assert.rejects(command("gh", ["run", "rerun", "123"], dir), error => gitDeliveryUnknown(error));
    await assert.rejects(command("gh", ["api", "user"], dir), error => !gitDeliveryUnknown(error));
  } finally {
    process.env.PATH = oldPath;
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test("SSH publickey refusal waits during an outage and escalates after a healthy probe", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { command } = await import("../core/git/index");
  const { ForgeOutageError } = await import("../core/forge/forge-health");
  const { SshAuthExhaustedError } = await import("../core/git/git-auth-retry");
  const dir = mkdtempSync(join(tmpdir(), "forge-ssh-"));
  const executable = join(dir, "git");
  writeFileSync(
    executable,
    '#!/bin/sh\nif [ "$1" = remote ]; then echo git@github.com:example/repo.git; exit 0; fi\necho "Permission denied (publickey)." >&2\nexit 128\n',
  );
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH,
    oldFetch = globalThis.fetch,
    oldNow = Date.now;
  let clock = oldNow() + 40_000,
    healthy = false;
  process.env.PATH = `${dir}:${oldPath}`;
  Date.now = () => clock;
  globalThis.fetch = (async () =>
    ({ ok: healthy }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      command("git", ["ls-remote", "origin"], dir),
      ForgeOutageError,
    );
    healthy = true;
    clock += 10_001;
    await assert.rejects(
      command("git", ["ls-remote", "origin"], dir),
      SshAuthExhaustedError,
    );
  } finally {
    process.env.PATH = oldPath;
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test('transient diagnostics distinguish locks, SSH and network from permanent failures', async () => {
  const { classifyGitCommandFailure: classifyGitTransientFailure } = await import('../core/forge/forge-health');
  assert.equal(classifyGitTransientFailure({ stderr: "Unable to create '/repo/.git/index.lock': File exists." }), 'lock');
  assert.equal(classifyGitTransientFailure(Error('SSH authentication retry budget exhausted after 3 attempts')), 'ssh');
  assert.equal(classifyGitTransientFailure({ stderr: 'HTTP 500' }), 'network');
  assert.equal(classifyGitTransientFailure({ code: 'ECONNRESET' }), 'network');
  assert.equal(classifyGitTransientFailure({ stderr: 'HTTP 403' }), null);
  assert.equal(classifyGitTransientFailure({ stderr: "Unable to create '/repo/other.lock': File exists." }), null);
});
