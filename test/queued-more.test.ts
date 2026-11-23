import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import { hiddenQueuedByProject } from "../shared/queued-more";

const queued = (repoPath: string, n: number) =>
  Array.from({ length: n }, () => ({ repoPath, phase: "queued" }));

test("each project reports what the board holds back, and a fully shown project reports nothing", () => {
  const tasks = [
    ...queued("/a", 5),
    ...queued("/b", 3),
    { repoPath: "/a", phase: "working" },
  ];
  assert.deepEqual(
    hiddenQueuedByProject(
      [
        { repoPath: "/a", count: 119 },
        { repoPath: "/b", count: 3 },
      ],
      tasks,
    ),
    [{ repoPath: "/a", hidden: 114 }],
  );
});

// Tom, 2026-11-06: "we need to stop adding things to the header on the board", and the column
// header "MUST show how many actual tasks are queued".
test("the Queue counts every queued task, and queue paging stays out of the board header", () => {
  const source = boardSource();
  assert.ok(!source.includes("' shown'"), "the count is the real total");
  assert.ok(
    !/queued · \$\{item\.repoPath\}/.test(source),
    "no per-project queue pills in the header",
  );
  const inbox = readFileSync(
    new URL("../shared/inbox-board.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    inbox,
    /queue: n\(["']Queued["']\) \+ hiddenQueued/,
    "the Queue total includes the held-back cards",
  );
  assert.match(
    source,
    /inboxCounts\(columns, hiddenQueued\)/,
    "the menu counts receive them",
  );
  // nucleus#1532: the held-back tasks are ordinary cards in the one list, read on scroll.
  assert.doesNotMatch(source, /…and \$\{item\.hidden\} more in/);
  assert.doesNotMatch(source, /"Previous"|"Next"/);
  assert.doesNotMatch(source, /queueRepo|queueOffset/);
  assert.match(
    source,
    /loadQueued\(queuedHidden\)/,
    "the list reads the held-back queue pages as it nears its end",
  );
  assert.match(
    source,
    /\{view === "queue" \? \([\s\S]*?\{queuedList\(\)\}[\s\S]*?\) : \(/,
    "the Queue list renders every queued task in the list's one scroll",
  );
  assert.match(
    source,
    /heldQueued\(repoPath\)\.map/,
    "a project's held-back tasks are drawn as ordinary cards",
  );
});
