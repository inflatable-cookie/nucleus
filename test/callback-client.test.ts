import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shared callback transport rejects malformed responses and timeouts without replay", async () => {
  const { callbackRequest } = await import(
    new URL("../shared/service/callback-client.mjs", import.meta.url).href
  );
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-callback-"))),
    socketPath = join(dir, "s");
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    if (req.url === "/invalid") res.end("not json");
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await assert.rejects(
      callbackRequest({ socketPath, token: "fixture" }, "/invalid", {}),
      /Invalid Queue response/,
    );
    // The server never answers /slow, so the budget only has to outlast delivery; 30 ms lost the request itself under load.
    await assert.rejects(
      callbackRequest(
        { socketPath, token: "fixture" },
        "/slow",
        {},
        { timeoutMs: 2_000 },
      ),
      /inspect current state/,
    );
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the callback environment reads the Nucleus names only", async () => {
  const { callbackEnvValue } = await import(
    new URL("../shared/service/callback-client.mjs", import.meta.url).href
  );
  assert.equal(callbackEnvValue("RUN_ID", { NUCLEUS_RUN_ID: "new" }), "new");
  assert.equal(
    callbackEnvValue("RUN_ID", { NORTHSTAR_RUN_ID: "old" }),
    undefined,
    "a retained old name is never read as a live credential",
  );
  assert.equal(
    callbackEnvValue("RUN_ID", {
      NUCLEUS_RUN_ID: "new",
      NORTHSTAR_RUN_ID: "old",
    }),
    "new",
  );
});
