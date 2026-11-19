import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { WebBoard } from "../service/web/web-board";
import { uiBoardSchema } from "../shared/contracts";

const board = uiBoardSchema.parse({
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  occupiedSlots: 0,
  globalLimit: 32,
  projectLimit: 5,
  tasks: [],
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [],
  prStates: {},
});

test("web bundle renders the board against the daemon protocol without Paseo", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR!, "web-shell-"));
  const { buildWeb } = await (new Function(
    "return import('../scripts/build-runtime.mjs')",
  )() as Promise<{ buildWeb(path: string): Promise<void> }>);
  const nestedClient = await readFile(
    join(process.cwd(), "client/board/cards.tsx"),
    "utf8",
  );
  assert.match(nestedClient, /from ["']\.\.\/shell["']/);
  await buildWeb(dir);
  const bundle = await readFile(join(dir, "app.js"), "utf8");
  assert.doesNotMatch(bundle, /@getpaseo\/plugin/);
  const calls: string[] = [];
  const server = new WebBoard({
    bundleDir: dir,
    host: {
      call: async (method) => {
        calls.push(method);
        if (method === "queue.ui-snapshot") return board;
        if (method === "lead.board") return { cards: [], links: [] };
        return [];
      },
      board: () => board,
      unavailable: () => null,
      subscribe: () => () => {},
    },
  });
  const port = await server.listen();
  const link = server.issueLink(5).url;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: link,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  try {
    let cookie = "";
    Object.assign(dom.window, {
      fetch: async (path: string, options: RequestInit = {}) => {
        const headers = new Headers(options.headers);
        if (cookie) headers.set("cookie", cookie);
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          ...options,
          headers,
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) cookie = setCookie.split(";")[0]!;
        return response;
      },
      TextDecoder,
      TextEncoder,
      AbortController,
    });
    dom.window.eval(`(() => { ${bundle} })()`);
    for (let i = 0; i < 200 && !calls.includes("queue.ui-snapshot"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      calls.includes("queue.ui-snapshot"),
      "board requested the snapshot through HTTP",
    );
    for (
      let i = 0;
      i < 200 &&
      !dom.window.document.querySelector('[data-live-channel="connected"]');
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      dom.window.document.querySelector('[data-live-channel="connected"]'),
      "live channel is connected before measuring polling",
    );
    // A board frame is decoded through the board contract before it reaches the
    // cache, so a real frame leaves no live-channel refusal behind.
    assert.equal(
      dom.window.document.querySelector("[data-live-error]"),
      null,
      "the live board frame decoded against the contract",
    );
    const reads = calls.filter(
      (method) => method === "queue.ui-snapshot",
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 4300));
    assert.equal(
      calls.filter((method) => method === "queue.ui-snapshot").length,
      reads,
      "the connected live channel suppresses snapshot interval polling",
    );
    assert.equal(
      dom.window.location.hash,
      "",
      "token was removed from the address",
    );
    assert.match(dom.window.document.body.textContent ?? "", /Queue|Nucleus/);

    // Standalone Settings route in T3 web: opens in standalone layout with a themed, keyboard-accessible Back control and returns to the board.
    const settingsBtn = dom.window.document.querySelector(
      '[aria-label="Settings"]',
    ) as HTMLElement | null;
    assert.ok(settingsBtn, "board header exposes Settings");
    settingsBtn.click();
    for (
      let i = 0;
      i < 200 &&
      !dom.window.document.querySelector(
        '[aria-label="Standalone Nucleus settings"]',
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const standalone = dom.window.document.querySelector(
      '[aria-label="Standalone Nucleus settings"]',
    ) as HTMLElement | null;
    assert.ok(standalone, "web Settings mounts in the standalone layout");
    const back = dom.window.document.querySelector(
      '[aria-label="Back to board"]',
    ) as HTMLElement | null;
    assert.ok(back, "standalone Settings renders the Back control");
    assert.equal(back.getAttribute("role"), "button");
    assert.equal(
      back.getAttribute("tabindex"),
      "0",
      "Back control is keyboard focusable",
    );
    assert.equal(
      dom.window.getComputedStyle(back).backgroundColor,
      "rgb(37, 41, 50)",
      "Back control uses the active dark surface2 theme colour",
    );
    assert.equal(
      dom.window.getComputedStyle(standalone).paddingLeft,
      "24px",
      "wide standalone Settings adds horizontal inset",
    );
    back.click();
    for (
      let i = 0;
      i < 200 && !dom.window.document.querySelector('[aria-label="Settings"]');
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      dom.window.document.querySelector('[aria-label="Settings"]'),
      "Back returns to the board",
    );
    assert.equal(
      dom.window.document.querySelector(
        '[aria-label="Standalone Nucleus settings"]',
      ),
      null,
    );
  } finally {
    dom.window.close();
    await server.close();
  }
});
