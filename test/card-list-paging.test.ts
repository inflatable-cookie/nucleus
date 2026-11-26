import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { rustTaskCard } from "./support/rust-task-card";
import { observeIntersections } from "./support/intersection";
import type { RustTask } from "../client/web/rust-board";

// nucleus#1608: a card list loads its next page as its end comes near view. These run the
// real list component on Rust adapter task shapes; the observer is a stand-in that the
// test fires when the sentinel scrolls into view.
useNativeStubs();
type ListModule = typeof import("../client/board/inbox-list");
let RustListRows: ListModule["RustListRows"];
const load = async () => {
  RustListRows ??= (await import("../client/board/inbox-list")).RustListRows;
};
const c = {} as never;

const tasks = (count: number, phase: RustTask["phase"] = "queued"): RustTask[] =>
  Array.from({ length: count }, (_, index) =>
    rustTaskCard(`task-${String(index).padStart(3, "0")}`, phase),
  );

const rustProps = (list: RustTask[]) => ({
  tasks: list,
  error: undefined,
  retry: () => {},
  selected: null,
  onSelect: () => {},
  project: () => ({ name: "Orbit", key: "orbit", badge: null }),
  busy: false,
});

/** The list keyed by its view, as the board mounts it, so a view change starts from page one. */
const list = (view: string, list: RustTask[]) =>
  [React.createElement(RustListRows, { key: view, c, view: view as never, rust: rustProps(list) })];

/** Mounts the list and unmounts it when the test ends, so its age tick stops. */
function mountList(t: { after(fn: () => void): void }, element: React.ReactElement[]) {
  const tree = mount(element as never);
  t.after(() => tree.update(React.createElement("View", null)));
  return tree;
}

const cards = (tree: ReturnType<typeof mount>) =>
  tree.all(/^task-\d{3}$/).length;

const sentinel = (tree: ReturnType<typeof mount>) =>
  tree.query(/^Show \d+ more tasks?$/);

test("scrolling the Queue list with 60 tasks loads pages 2 and 3 without a click", async (t) => {
  await load();
  const { enter } = observeIntersections(t);
  const tree = mountList(t, list("queue", tasks(60)));
  assert.equal(cards(tree), 25);
  const first = sentinel(tree);
  assert.ok(first, "the list ends in a sentinel while tasks remain");
  enter(first as unknown as HostNode);
  assert.equal(cards(tree), 50, "the second page arrives on approach");
  enter(sentinel(tree) as unknown as HostNode);
  assert.equal(cards(tree), 60, "the third page is the last");
  assert.equal(sentinel(tree), undefined, "no sentinel once every task shows");
});

test("keyboard focus moving past the last loaded card loads the next page", async (t) => {
  await load();
  observeIntersections(t);
  const tree = mountList(t, list("queue", tasks(60)));
  const first = sentinel(tree)!;
  (first.props.onFocus as () => void)();
  assert.equal(cards(tree), 50);
});

test("a view change starts again from the first page", async (t) => {
  await load();
  const { enter } = observeIntersections(t);
  const root = mountList(t, list("queue", tasks(60)));
  enter(sentinel(root) as unknown as HostNode);
  assert.equal(cards(root), 50);
  root.update(list("review", tasks(60, "reviewing")) as never);
  assert.equal(cards(root), 25, "the new view reads its own first page");
});

test("without an observer the list keeps one control for the next page", async (t) => {
  await load();
  const globals = globalThis as { IntersectionObserver?: unknown };
  assert.equal(globals.IntersectionObserver, undefined);
  const tree = mountList(t, list("queue", tasks(30)));
  assert.equal(cards(tree), 25);
  tree.press("Show 5 more tasks");
  assert.equal(cards(tree), 30);
  assert.equal(sentinel(tree), undefined);
});

test("focus on the sentinel that loads a page moves to the page's first new card, so forward Tab reaches the new cards", async () => {
  const { JSDOM } = await import("jsdom");
  const { focusAddedCard, keyboardOrder } = await import("../client/board/page-sentinel");
  const dom = new JSDOM(
    '<div id="list"><button id="card-1">1</button><button id="card-2">2</button><div id="sentinel" tabindex="0"></div></div>',
  );
  const doc = dom.window.document;
  const root = doc.getElementById("list")!;
  const sentinel = doc.getElementById("sentinel")!;
  // Focus stands on the sentinel when its page loads.
  sentinel.focus();
  const at = keyboardOrder(root).indexOf(sentinel);
  assert.equal(at, 2);
  // The page inserts its cards ahead of the sentinel, which stays at the end.
  for (const id of ["card-3", "card-4"]) {
    const card = doc.createElement("button");
    card.id = id;
    root.insertBefore(card, sentinel);
  }
  assert.equal(focusAddedCard(root, at), true);
  assert.equal(doc.activeElement?.id, "card-3", "focus moves to the first new card");
  // Forward Tab order from there visits the new cards before the sentinel.
  const order = keyboardOrder(root).map((element) => element.id);
  assert.deepEqual(order, ["card-1", "card-2", "card-3", "card-4", "sentinel"]);
  assert.equal(order[order.indexOf("card-3") + 1], "card-4");
});
