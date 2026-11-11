import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { WebBoard } from "../service/web/web-board";
import { uiBoardSchema } from "../shared/contracts";

const board = uiBoardSchema.parse({ revision: 1, connected: true, hostId: "host", paused: false, error: "", quiet: true, activeWorkers: 0, unsettled: 0, occupiedSlots: 0, globalLimit: 32, projectLimit: 5, tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [], prStates: {} });

test("web bundle renders the board against the daemon protocol without Paseo", async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR!, "web-shell-"));
  const { buildWeb } = await (new Function("return import('../scripts/build-runtime.mjs')")() as Promise<{ buildWeb(path: string): Promise<void> }>);
  const nestedClient = await readFile(join(process.cwd(), "client/board/cards.tsx"), "utf8");
  assert.match(nestedClient, /from ["']\.\.\/shell["']/);
  await buildWeb(dir);
  const bundle = await readFile(join(dir, "app.js"), "utf8");
  assert.doesNotMatch(bundle, /@getpaseo\/plugin/);
  const calls: string[] = [];
  const server = new WebBoard({ bundleDir: dir, host: {
    call: async method => { calls.push(method); if (method === "queue.ui-snapshot") return board; if (method === "lead.board") return { cards: [], links: [] }; return []; },
    board: () => board, unavailable: () => null, subscribe: () => () => {},
  } });
  const port = await server.listen();
  const link = server.issueLink(5).url;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: link, runScripts: "dangerously", pretendToBeVisual: true });
  try {
    Object.assign(dom.window, { fetch: (path: string, options: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, options), TextDecoder, TextEncoder, AbortController });
    dom.window.eval(`(() => { ${bundle} })()`);
    for (let i = 0; i < 200 && !calls.includes("queue.ui-snapshot"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(calls.includes("queue.ui-snapshot"), "board requested the snapshot through HTTP");
    for (let i = 0; i < 200 && !dom.window.document.querySelector('[data-live-channel="connected"]'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(dom.window.document.querySelector('[data-live-channel="connected"]'), "live channel is connected before measuring polling");
    const reads = calls.filter(method => method === "queue.ui-snapshot").length;
    await new Promise(resolve => setTimeout(resolve, 4300));
    assert.equal(calls.filter(method => method === "queue.ui-snapshot").length, reads, "the connected live channel suppresses snapshot interval polling");
    assert.equal(dom.window.location.hash, "", "token was removed from the address");
    assert.match(dom.window.document.body.textContent ?? "", /Queue|Nucleus/);
  } finally { dom.window.close(); await server.close(); }
});
