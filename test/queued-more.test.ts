import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from './support/board-source';
import { hiddenQueuedByProject } from "../shared/queued-more";

const queued = (repoPath: string, n: number) => Array.from({ length: n }, () => ({ repoPath, phase: "queued" }));

test("each project reports what the board holds back, and a fully shown project reports nothing", () => {
  const tasks = [...queued("/a", 5), ...queued("/b", 3), { repoPath: "/a", phase: "working" }];
  assert.deepEqual(hiddenQueuedByProject([{ repoPath: "/a", count: 119 }, { repoPath: "/b", count: 3 }], tasks),
    [{ repoPath: "/a", hidden: 114 }]);
});

// Tom, 2026-11-06: "we need to stop adding things to the header on the board", and the column
// header "MUST show how many actual tasks are queued".
test("the Queued column counts every queued task, and queue paging stays out of the board header", () => {
  const source = boardSource();
  assert.ok(!source.includes("' shown'"), "the column count is the real total");
  assert.ok(!/queued · \$\{item\.repoPath\}/.test(source), "no per-project queue pills in the header");
  assert.match(source, /Queued: pipelineCounts\.Queued \+ hiddenQueued/, "the Queued header total includes the held-back cards");
  assert.match(source, /…and \$\{item\.hidden\} more/);
  assert.match(source, /const more = name === 'Queued' \? queuedMoreCards : triageMore/);
  assert.match(source, /contentContainerStyle=\{\{ gap: space.xs \}\}[\s\S]*?\{cards\}[\s\S]*?\{more\}[\s\S]*?<\/ScrollView>/,
    "the overflow card is rendered inside the column's own scrolling cell");
});

test("frontier grants live on the Limits tab, not the board header", () => {
  const board = boardSource();
  // The Limits panel moved to client/limits.tsx; Settings renders it on the capacity tab.
  const settings = readFileSync(new URL("../client/settings-screen.tsx", import.meta.url), "utf8");
  const limits = readFileSync(new URL("../client/limits.tsx", import.meta.url), "utf8");
  assert.ok(!board.includes("routingGrants"), "the board renders no grants");
  assert.ok(!board.includes("api.routingGrant"), "the board holds no revoke control");
  assert.match(settings, /settingsTab === "capacity"[\s\S]*?<DispatchLimits /);
  assert.match(limits, /<FrontierGrants /);
  // Tom, 2026-11-06: each grant is a card, and its reason opens from a ? rather than sitting in it.
  assert.match(limits, /<GrantCard /);
  assert.match(limits, /const detail = `\$\{grant\.reason[\s\S]*?<HelpTip c=\{c\} label=\{`Grant for [^\n]*text=\{detail\}/);
  assert.equal(limits.match(/\{grant\.reason\}<\/Text>/g), null, "the reason isn't printed in the card");
  assert.equal(limits.match(/\{detail\}<\/Text>/g), null, "nor is the detail that carries it");
});
