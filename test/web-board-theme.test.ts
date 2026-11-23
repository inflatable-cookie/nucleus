import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { roles } from "../client/design";
import { QueueService } from "../service/transport/server";
import { readServiceInfo } from "../service/transport/identity";
import { uiBoardSchema } from "../shared/contracts";
import { ServiceClient } from "../shared/service/client";
import { boardThemeSnapshotSchema } from "../shared/web-theme";
import { socketFixtureDirectory } from "./support/socket-fixture";
import { t3Fake } from "./support/t3code-fake";

const themes: {
  stock: Record<string, unknown>;
  ember: unknown;
  seeded: unknown;
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/t3code-board-themes.json", import.meta.url),
    "utf8",
  ),
);
const themeResponse = z.object({ theme: boardThemeSnapshotSchema.nullable() });
const health = z.object({
  t3code: z.object({ connected: z.boolean() }).optional(),
});

test("T3 board opens re-read environment themes through the connected host, independently of board snapshots", async (t) => {
  const dataDir = socketFixtureDirectory("queue-service.sock");
  const fake = await t3Fake(t, dataDir);
  const config = { endpoint: fake.endpoint, bearer: "synthetic-board-theme" };
  const service = new QueueService({
    fixture: "fake",
    owner: { dataDir, timers: false, settings: { t3code: config } },
    webBoard: { port: 0, bundleDir: null },
  });
  let owner: ServiceClient | undefined;
  t.after(async () => {
    owner?.close();
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await service.start();
  const info = readServiceInfo(dataDir);
  assert.ok(info?.httpPort);
  const url = `http://127.0.0.1:${info.httpPort}`;
  owner = new ServiceClient({
    socketPath: info.socketPath,
    credential: info.credential,
  });
  await owner.connect();
  const deadline = Date.now() + 10_000;
  while (!health.parse(await owner.health()).t3code?.connected) {
    assert.ok(
      Date.now() < deadline,
      "T3 must register before opening the board",
    );
    await delay(20);
  }

  const client = owner;
  async function pair(surface?: "t3code") {
    const issued = z
      .object({ url: z.string() })
      .parse(await client.request("service.ui-link", { surface }));
    const token = new URLSearchParams(new URL(issued.url).hash.slice(1)).get(
      "token",
    );
    const response = await fetch(`${url}/api/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return { cookie };
  }
  const readTheme = async (
    headers: { cookie: string },
    signal?: AbortSignal,
  ) => {
    const response = await fetch(`${url}/api/theme`, { headers, signal });
    assert.equal(response.status, 200);
    return themeResponse.parse(await response.json()).theme;
  };
  async function boardSnapshot(headers: { cookie: string }) {
    const response = await fetch(`${url}/api/rpc`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ method: "queue.ui-snapshot", input: {} }),
    });
    assert.equal(response.status, 200);
    return z.object({ result: uiBoardSchema }).parse(await response.json())
      .result;
  }

  assert.equal((await fetch(`${url}/api/theme`)).status, 401);
  const standalone = await pair();
  assert.equal(await readTheme(standalone), null);
  assert.equal(
    fake.requests.filter(({ tag }) => tag === "server.getSettings").length,
    0,
  );

  fake.controls.settings = themes.stock;
  const t3 = await pair("t3code");
  assert.deepEqual(await readTheme(t3), {
    themeId: null,
    appearance: "dark",
  });
  const stockBoard = await boardSnapshot(t3);

  // No definition is inferred from a built-in id. A published definition with
  // this id is synthetic coverage for a server that does return one.
  fake.controls.settings = { defaultTheme: "ember", defaultAppearance: "dark" };
  assert.deepEqual(await readTheme(t3), {
    themeId: "ember",
    appearance: "dark",
  });
  fake.controls.environmentThemes = [themes.ember, themes.seeded];
  const ember = await readTheme(await pair("t3code"));
  assert.deepEqual(ember?.dark?.colors, {
    surface0: "#241c1a",
    surface1: "#302520",
    surface2: "#3c2e27",
    foreground: "#f9ebe0",
    foregroundMuted: "#c4aa99",
    border: "#75594b",
    accent: "#ffae6f",
    accentForeground: "#351e12",
    statusDanger: "#fa9487",
    statusWarning: "#f9c66d",
    statusSuccess: "#a9ca8c",
    surfaceHover: "#4a372d",
    surfaceSelected: "#624333",
  });
  assert.equal(ember?.light?.colors.surface0, "#fcf7f1");
  assert.equal(ember?.light?.colors.surfaceSelected, "oklch(0.83 0.08 61)");
  assert.equal("css" in (ember ?? {}), false);
  assert.deepEqual(await boardSnapshot(t3), stockBoard);

  fake.controls.settings.defaultAppearance = "light";
  assert.equal((await readTheme(await pair("t3code")))?.appearance, "light");

  fake.controls.settings = {
    defaultTheme: "forest-fixture",
    defaultAppearance: "system",
  };
  assert.deepEqual((await readTheme(t3))?.dark, {
    seeds: { canvas: "#162720", accent: "#94cba4" },
    colors: { foreground: "#effbf2" },
  });
  assert.equal(
    fake.requests.filter(({ tag }) => tag === "subscribeServerConfig").length,
    4,
  );
  assert.ok(
    fake.requests.some(
      ({ tag, payload }) =>
        tag === "subscribeServerConfig" && payload.environmentThemes === true,
    ),
  );
  assert.deepEqual(fake.bearers, ["Bearer synthetic-board-theme"]);

  fake.controls.settings = { defaultTheme: 42 };
  assert.equal(await readTheme(t3), null);
  assert.equal(await readTheme(standalone), null);
  assert.deepEqual(await boardSnapshot(t3), stockBoard);

  const settingsReads = fake.requests.filter(
    ({ tag }) => tag === "server.getSettings",
  ).length;
  fake.controls.stalledMethods.push("server.getSettings");
  const abort = new AbortController();
  const held = assert.rejects(readTheme(t3, abort.signal), {
    name: "AbortError",
  });
  try {
    const heldDeadline = Date.now() + 3000;
    while (
      fake.requests.filter(({ tag }) => tag === "server.getSettings").length ===
      settingsReads
    ) {
      assert.ok(
        Date.now() < heldDeadline,
        "the host received the theme request",
      );
      await delay(20);
    }
    assert.deepEqual(await boardSnapshot(t3), stockBoard);
  } finally {
    abort.abort();
    await held;
  }
});

test("board interaction roles accept T3 colours and keep the existing host defaults", () => {
  const colors = {
    surface0: "#111318",
    surface1: "#1a1d24",
    surface2: "#252932",
    foreground: "#f1f3f5",
    foregroundMuted: "#a5acb8",
    border: "#39404b",
    accent: "#8caaff",
    accentForeground: "#101521",
    statusSuccess: "#71c99a",
    statusWarning: "#e9bc68",
    statusDanger: "#ef8282",
  };
  assert.equal(roles(colors).hover, "rgba(241, 243, 245, 0.06)");
  assert.equal(roles(colors).selected, "rgba(241, 243, 245, 0.1)");
  const themed = roles({
    ...colors,
    surfaceHover: "#4a372d",
    surfaceSelected: "#624333",
  });
  assert.equal(themed.hover, "#4a372d");
  assert.equal(themed.selected, "#624333");
});
