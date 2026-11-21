/**
 * nucleus#1481: the default Nucleus CLI transport belongs to the neutral client
 * owner, not the Paseo integration. These prove which transport a caller
 * selects, and that nothing falls back from one to the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callerCliFixture } from "./support/caller-cli-fixture";
import { queueClient } from "../bin/queue-client.mjs";

test("a host-less CLI read connects directly to the service socket", async () => {
  const f = await callerCliFixture();
  try {
    const result = await f.invoke("none", "queue-cli.mjs", ["lanes"]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, "lanes");
    assert.equal(
      f.hostResolutions.length,
      0,
      "a read with no host identity asks no host",
    );
  } finally {
    await f.close();
  }
});

test("a native T3-only CLI read connects directly to the service socket", async () => {
  const f = await callerCliFixture();
  try {
    const result = await f.invoke("none", "queue-cli.mjs", ["lanes"], undefined, {
      T3CODE_THREAD_ID: "mcp:native-only-thread",
      T3CODE_DESKTOP_HOST_SCOPE: "synthetic-scope",
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Synthetic caller payload received/);
    assert.equal(f.calls.at(-1)?.method, "lanes");
  } finally {
    await f.close();
  }
});

test("--via-paseo selects the bridge and never falls back to the service socket", async () => {
  const f = await callerCliFixture();
  try {
    // The fixture data home is not a Paseo one, so the explicit bridge cannot
    // build its client: it reports that instead of using the local service.
    const result = await f.invoke("none", "queue-cli.mjs", [
      "lanes",
      "--via-paseo",
    ]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /settings\.json/);
    assert.equal(f.calls.length, 0, "the local service socket was not used");
  } finally {
    await f.close();
  }
});

test("the default transport is the neutral client and ignores a Paseo client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transport-"));
  let bridgeTouched = false;
  const paseoClient = {
    connect: async () => {
      bridgeTouched = true;
    },
    close: () => {},
    getPluginCatalog: async () => {
      bridgeTouched = true;
      return [{ id: "nucleus" }];
    },
  };
  try {
    // A data home with no service is a clear refusal, not a bridge fallback.
    const client = await queueClient({ dataDir: dir, paseoClient });
    await assert.rejects(client.connect(), /Nucleus service is unavailable/);
    assert.equal(bridgeTouched, false, "the Paseo bridge was not selected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
